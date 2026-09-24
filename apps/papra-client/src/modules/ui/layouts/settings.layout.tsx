import type { ParentComponent } from 'solid-js';
import { AppLayout } from './organization.layout';

export const SettingsLayout: ParentComponent = (props) => <AppLayout>{props.children}</AppLayout>;
