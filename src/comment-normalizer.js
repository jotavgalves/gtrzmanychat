function sqliteTimestamp(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function normalizeCreatedAt(value) {
  if (!value) return null;
  const numeric = Number(value);
  const date = Number.isFinite(numeric) && numeric > 0
    ? new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : sqliteTimestamp(date);
}

export function normalizeInstagramCommentEvents(payload) {
  const comments = [];
  if (!payload || payload.object !== 'instagram' || !Array.isArray(payload.entry)) return comments;

  for (const entry of payload.entry) {
    const changes = [];
    if (entry?.field) changes.push({ field: entry.field, value: entry.value });
    if (Array.isArray(entry?.changes)) changes.push(...entry.changes);

    for (const change of changes) {
      if (change?.field !== 'comments' && change?.field !== 'live_comments') continue;
      const value = change.value || {};
      const commentId = value.id || value.comment_id;
      if (!commentId) continue;
      comments.push({
        commentId: String(commentId),
        contactId: value.from?.id ? String(value.from.id) : null,
        username: value.from?.username || null,
        mediaId: value.media?.id ? String(value.media.id) : value.media_id ? String(value.media_id) : null,
        text: typeof value.text === 'string' ? value.text : '',
        createdAt: normalizeCreatedAt(value.created_time),
        source: change.field === 'live_comments' ? 'live_comment' : 'comment',
      });
    }
  }
  return comments;
}
