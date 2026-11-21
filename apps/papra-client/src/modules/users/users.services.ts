import type { UserMe } from './users.types';
import { apiClient } from '../shared/http/api-client';

export const currentUserQueryKey = ['users', 'me'] as const;

export async function fetchCurrentUser({ signal }: { signal?: AbortSignal } = {}) {
  const { user } = await apiClient<{ user: UserMe }>({
    path: '/api/users/me',
    method: 'GET',
    signal,
  });

  return { user };
}

export async function updateUser({ name }: { name: string }) {
  const { user } = await apiClient<{ user: UserMe }>({
    path: '/api/users/me',
    method: 'PUT',
    body: { name },
  });

  return { user };
}
