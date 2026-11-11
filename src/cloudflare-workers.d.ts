// Only what this package reads from the Workers runtime module. Imported
// dynamically, so outside Workers (Node tests) the import just fails and is caught.
declare module "cloudflare:workers" {
	export const env: Record<string, unknown>;
}
