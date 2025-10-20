/**
 * Chat Components
 *
 * Public API for chat feature components
 */

// Ensure tools are registered on import
import './tools/registerTools';

// Re-export main components
export { Chat } from '../Chat';
export { MessageItem } from '../MessageItem';
export { MessageInput } from '../MessageInput';

// Re-export new architecture components
export { BlockRenderer } from './blocks';
export { toolRegistry } from './tools';
export { chatTheme } from './theme';
