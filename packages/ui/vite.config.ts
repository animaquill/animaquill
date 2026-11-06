import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Runs the editor on its own, for working on the interface and for the browser tests. */
export default defineConfig({
  root: "dev",
  plugins: [react()],
  // The compositor runs in a sandbox with no origin of its own, so its modules need CORS.
  server: { host: "0.0.0.0", port: 5173, strictPort: true, cors: true },
});
