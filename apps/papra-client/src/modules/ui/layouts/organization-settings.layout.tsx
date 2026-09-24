import type { ParentComponent } from 'solid-js';
import { OrganizationLayout } from './organization.layout';

export const OrganizationSettingsLayout: ParentComponent = (props) => (
  <OrganizationLayout>{props.children}</OrganizationLayout>
);
