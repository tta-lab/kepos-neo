export interface HomeRegistry {
  schemaVersion: 1;
  revision: 1;
  publisher: {
    displayName: "Local Publisher";
  };
  services: [
    {
      id: "home";
      name: "Home";
      kind: "http";
      serviceKey: string;
    },
  ];
}

const homeKeyPattern = /^[0-9a-f]{64}$/;

export function createHomeRegistry(homeKey: string): HomeRegistry {
  if (!homeKeyPattern.test(homeKey)) {
    throw new Error("Home key must be 32 bytes of lowercase hex");
  }

  return {
    schemaVersion: 1,
    revision: 1,
    publisher: {
      displayName: "Local Publisher",
    },
    services: [
      {
        id: "home",
        name: "Home",
        kind: "http",
        serviceKey: homeKey,
      },
    ],
  };
}
