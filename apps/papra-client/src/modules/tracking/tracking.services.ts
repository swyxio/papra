import { PostHog } from 'posthog-js-lite';
import { buildTimeConfig, isDev } from '../config/config';

type TrackingServices = {
  capture: (args: {
    event: string;
    properties?: Record<string, string | number | boolean>;
  }) => void;
  captureTiming: (args: {
    event: string;
    properties: Record<string, string | number | boolean>;
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
  captureTiming: () => {},
  reset: () => {},
  identify: () => {},
};

class TimingPostHog extends PostHog {
  getCommonEventProperties() {
    // posthog-js-lite adds the full URL after caller properties. A separate
    // anonymous instance keeps document routes and account identity out of timings.
    return { $process_person_profile: false };
  }

  async fetch(url: string, options: Parameters<PostHog['fetch']>[1]) {
    return fetch(url, { ...options, referrerPolicy: 'no-referrer' });
  }
}

function createTrackingServices(): TrackingServices {
  const { isEnabled, renameTimingEnabled, apiKey, host } = buildTimeConfig.posthog;
  if (!apiKey || (!isEnabled && !renameTimingEnabled)) return dummyTrackingServices;

  let posthog: PostHog | undefined;
  let timings: TimingPostHog | undefined;
  const tracker = () => {
    if (!isEnabled || /^\/(?:feedback(?:\/|$)|s\/|sign\/|review\/)/.test(window.location.pathname))
      return undefined;
    return (posthog ??= new PostHog(apiKey, { host }));
  };

  return {
    capture: ({ event, properties }) => {
      tracker()?.capture(event, properties);
    },
    captureTiming: ({ event, properties }) => {
      if (!renameTimingEnabled) return;
      timings ??= new TimingPostHog(apiKey, {
        host,
        persistence: 'memory',
        persistence_name: 'swyxdrive_rename_timing',
        preloadFeatureFlags: false,
        disableGeoip: true,
      });
      timings.capture(event, properties);
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
