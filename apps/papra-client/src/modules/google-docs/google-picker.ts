import type { GooglePickerConfig } from './google-docs.services';

type PickerResult = { action: string; docs?: { id: string }[] };
type Picker = { setVisible: (visible: boolean) => void };
type PickerBuilder = {
  addView: (view: unknown) => PickerBuilder;
  setOAuthToken: (token: string) => PickerBuilder;
  setDeveloperKey: (key: string) => PickerBuilder;
  setAppId: (id: string) => PickerBuilder;
  setOrigin: (origin: string) => PickerBuilder;
  setTitle: (title: string) => PickerBuilder;
  setCallback: (callback: (result: PickerResult) => void) => PickerBuilder;
  build: () => Picker;
};
type GoogleApis = {
  accounts: {
    oauth2: {
      initTokenClient: (config: {
        client_id: string;
        scope: string;
        include_granted_scopes: boolean;
        login_hint?: string;
        callback: (response: {
          access_token?: string;
          expires_in?: number;
          scope?: string;
          error?: string;
        }) => void;
        error_callback: () => void;
      }) => { requestAccessToken: (options: { prompt: string }) => void };
    };
  };
  picker: {
    PickerBuilder: new () => PickerBuilder;
    DocsView: new () => { setMimeTypes: (types: string) => unknown };
    Action: { PICKED: string; CANCEL: string };
  };
};
type GoogleWindow = Window &
  typeof globalThis & {
    google?: GoogleApis;
    gapi?: {
      load: (
        name: string,
        options: {
          callback: () => void;
          onerror: () => void;
          timeout: number;
          ontimeout: () => void;
        },
      ) => void;
    };
  };
const googleWindow = () => window as GoogleWindow;
const scriptLoads = new Map<string, Promise<void>>();
async function loadScript(src: string) {
  const existing = scriptLoads.get(src);
  if (existing) return existing;
  const result = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    const timeout = setTimeout(() => {
      script.remove();
      scriptLoads.delete(src);
      reject(new Error('Google took too long to load. Please try again.'));
    }, 15000);
    script.onload = () => {
      clearTimeout(timeout);
      resolve();
    };
    script.onerror = () => {
      clearTimeout(timeout);
      script.remove();
      scriptLoads.delete(src);
      reject(new Error('Could not load Google. Check your browser connection and try again.'));
    };
    document.head.append(script);
  });
  scriptLoads.set(src, result);
  return result;
}
export type SelectedFileGrant = { accessToken: string; expiresAt: number };
// Load before clicking; invoke the returned function directly from a user gesture.
// Tokens stay in memory and request drive.file, never whole-Drive access.
export async function prepareGoogleAuthorization(config: GooglePickerConfig, loginHint?: string) {
  if (!config.clientId)
    throw new Error('Google export is not configured. You can still download Word.');
  await loadScript('https://accounts.google.com/gsi/client');
  return async (): Promise<SelectedFileGrant> =>
    new Promise((resolve, reject) => {
      const google = googleWindow().google;
      if (!google) {
        reject(new Error('Google authorization could not load.'));
        return;
      }
      const client = google.accounts.oauth2.initTokenClient({
        client_id: config.clientId,
        scope: 'https://www.googleapis.com/auth/drive.file',
        include_granted_scopes: false,
        ...(loginHint ? { login_hint: loginHint } : {}),
        error_callback: () =>
          reject(new Error('Google authorization was cancelled or blocked. Please try again.')),
        callback: (response) => {
          if (
            response.error ||
            !response.access_token ||
            (response.scope &&
              !response.scope.split(' ').includes('https://www.googleapis.com/auth/drive.file'))
          ) {
            reject(new Error('Google did not grant per-file access. Please try again.'));
            return;
          }
          resolve({
            accessToken: response.access_token,
            expiresAt: Date.now() + (response.expires_in ?? 3600) * 1000,
          });
        },
      });
      client.requestAccessToken({ prompt: 'select_account' });
    });
}
export async function prepareGooglePicker(config: GooglePickerConfig) {
  if (!config.clientId || !config.appId || !config.pickerApiKey)
    throw new Error(
      'Private Google Docs access is not configured yet. An administrator must enable Google Picker. Public documents can still be converted without a Google account.',
    );
  const [authorize] = await Promise.all([
    prepareGoogleAuthorization(config),
    loadScript('https://apis.google.com/js/api.js'),
  ]);
  await new Promise<void>((resolve, reject) => {
    const gapi = googleWindow().gapi;
    if (!gapi) {
      reject(new Error('Google Picker could not load.'));
      return;
    }
    gapi.load('picker', {
      callback: resolve,
      onerror: () => reject(new Error('Google Picker could not load.')),
      timeout: 10000,
      ontimeout: () => reject(new Error('Google Picker took too long to load.')),
    });
  });
  return async (fileId: string): Promise<SelectedFileGrant> => {
    const grant = await authorize();
    return new Promise((resolve, reject) => {
      const google = googleWindow().google!;
      let picker: Picker;
      picker = new google.picker.PickerBuilder()
        .addView(
          new google.picker.DocsView().setMimeTypes(
            'application/vnd.google-apps.document,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword',
          ),
        )
        .setOAuthToken(grant.accessToken)
        .setDeveloperKey(config.pickerApiKey!)
        .setAppId(config.appId)
        .setOrigin(window.location.origin)
        .setTitle('Select the document you imported')
        .setCallback((result) => {
          if (result.action === google.picker.Action.CANCEL) {
            picker.setVisible(false);
            reject(new Error('Document selection was cancelled.'));
          }
          if (result.action !== google.picker.Action.PICKED) return;
          picker.setVisible(false);
          if (result.docs?.length !== 1 || result.docs[0].id !== fileId) {
            reject(new Error('Please select the same Google Doc as the imported URL.'));
            return;
          }
          resolve(grant);
        })
        .build();
      picker.setVisible(true);
    });
  };
}
