// Runs the on-device language model (WebLLM) off the main thread.
import { WebWorkerMLCEngineHandler } from '../vendor/webllm.mjs';

const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg) => handler.onmessage(msg);
