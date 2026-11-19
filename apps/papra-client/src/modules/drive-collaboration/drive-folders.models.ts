// Placeholder id for a folder being created optimistically; the server has not assigned an id yet.
export const pendingFolderPrefix = 'pending_';
export const isPendingFolderId = (id: string | undefined) => !!id?.startsWith(pendingFolderPrefix);
