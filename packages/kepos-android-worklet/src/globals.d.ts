declare const Bare: {
  argv: string[];
};

declare const BareKit: {
  IPC: {
    on(event: "data", listener: (data: Uint8Array) => void): void;
    write(data: Uint8Array): boolean;
  };
};
