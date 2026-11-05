import { z } from "zod";

// By default Zod generates code at run time to parse faster. The editor's Content-Security-Policy
// forbids that, and even trying counts as a violation, reported in the console of every visitor.
// This has to run before the first schema is defined, so `basics.ts` imports it first.
z.config({ jitless: true });
