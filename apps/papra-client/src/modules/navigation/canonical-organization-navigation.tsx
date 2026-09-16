import { useLocation, useNavigate } from '@solidjs/router';
import { createEffect } from 'solid-js';
import { canonicalOrganizationUrl } from './organization-urls';

export function CanonicalOrganizationNavigation() {
  const location = useLocation();
  const navigate = useNavigate();

  createEffect(() => {
    const current = location.pathname + location.search + location.hash;
    const canonical = canonicalOrganizationUrl(current);
    if (canonical !== current) {
      navigate(canonical, { replace: true, scroll: false, state: location.state });
    }
  });

  return null;
}
