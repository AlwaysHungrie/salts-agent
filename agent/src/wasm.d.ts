/** A `.wasm` import is a `WebAssembly.Module` bundled by Wrangler; libopus has no types. */
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
