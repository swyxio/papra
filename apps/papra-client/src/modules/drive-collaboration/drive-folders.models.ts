// Placeholder id for a folder being created optimistically; the server has not assigned an id yet.
export const pendingFolderPrefix = 'pending_';
export const isPendingFolderId = (id: string | undefined) => !!id?.startsWith(pendingFolderPrefix);

// Shift-click selection: set every id between the anchor and the clicked id to `selected`.
export function selectRange({
  ids,
  anchorId,
  targetId,
  selected,
  selection,
}: {
  ids: string[];
  anchorId: string | undefined;
  targetId: string;
  selected: boolean;
  selection: Record<string, boolean>;
}): Record<string, boolean> {
  const target = ids.indexOf(targetId);
  const anchor = anchorId === undefined ? -1 : ids.indexOf(anchorId);
  const [start, end] =
    anchor < 0 ? [target, target] : [Math.min(anchor, target), Math.max(anchor, target)];
  const next = { ...selection };
  for (const id of ids.slice(start, end + 1)) {
    if (selected) next[id] = true;
    else delete next[id];
  }
  return next;
}

// Folders that cannot receive a move of `movingIds`: the moving folders and everything inside them.
export function blockedMoveTargets(
  folders: { id: string; parentId: string | null }[],
  movingIds: string[],
): Set<string> {
  const blocked = new Set(movingIds);
  for (let grew = true; grew; ) {
    grew = false;
    for (const folder of folders)
      if (folder.parentId && blocked.has(folder.parentId) && !blocked.has(folder.id)) {
        blocked.add(folder.id);
        grew = true;
      }
  }
  return blocked;
}
