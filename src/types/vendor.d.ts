declare module "hyperdht" {
  const value: unknown;
  export default value;
}

declare module "protomux" {
  const value: unknown;
  export default value;
}

declare module "compact-encoding" {
  const value: unknown;
  export default value;
}

declare module "hypercore-crypto" {
  const value: {
    randomBytes(size: number): Buffer;
  };
  export default value;
}

declare module "sodium-universal" {
  const value: {
    sodium_memcmp(left: Uint8Array, right: Uint8Array): boolean;
  };
  export default value;
}

declare module "which-runtime" {
  export const isWindows: boolean;
}
