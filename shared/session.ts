export function chatHasStarted(chat: {
  message_count?: number;
  last_user_message_at?: string | null;
  gateway_revision?: string | null;
}) {
  return !!(chat.message_count || chat.last_user_message_at || chat.gateway_revision);
}
