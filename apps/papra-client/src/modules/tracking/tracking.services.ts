import { PostHog } from 'posthog-js-lite';
import { buildTimeConfig, isDev } from '../config/config';

type TrackingServices = {
  capture: (args: {
    event: string;
    properties?: Record<string, string | number | boolean>;
  }) => void;

  reset: () => void;

  identify: (args: { userId: string; email: string }) => void;
};

const dummyTrackingServices: TrackingServices = {
  capture: ({ event, ...args }) => {
    if (isDev) {
      // eslint-disable-next-line no-console
      console.log(`[dev] captured event ${event}`, ...(Object.keys(args).length ? [args] : []));
    }
  },
  reset: () => {},
  identify: () => {},
};

function createTrackingServices(): TrackingServices {
  const { isEnabled, apiKey, host } = buildTimeConfig.posthog;

  if (!isEnabled) {
    return dummyTrackingServices;
  }

  if (!apiKey) {
    return dummyTrackingServices;
  }

  let posthog: PostHog | undefined;
  const tracker = () => {
    if (/^\/(?:feedback(?:\/|$)|s\/|sign\/|review\/)/.test(window.location.pathname))
      return undefined;
    return (posthog ??= new PostHog(apiKey, { host }));
  };

  return {
    capture: ({ event, properties }) => {
      tracker()?.capture(event, properties);
    },
    reset: () => {
      posthog?.reset();
    },
    identify: ({ userId, email }) => {
      tracker()?.identify(userId, { email });
    },
  };
}

export const trackingServices = createTrackingServices();
