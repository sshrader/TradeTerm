// Solana libraries expect Node's Buffer. This gives them the browser version.
import { Buffer } from 'buffer';
globalThis.Buffer = globalThis.Buffer || Buffer;
export { Buffer };
