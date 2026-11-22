import { buildApp } from "../src/app";

// Vercel uses the exported Express handler as a Node.js Function. The app is
// created once per warm instance and reused for subsequent requests.
const app = buildApp();

export default app;
