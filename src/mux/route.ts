export type Route = "auto" | "public";

export interface RouteConnectionOptions {
  localConnection: boolean;
  reusableSocket: true;
}

export function parseRoute(value: string): Route {
  if (value === "auto" || value === "public") return value;
  throw new Error("route must be auto or public");
}

export function connectionOptionsForRoute(
  route: string,
): RouteConnectionOptions {
  const parsed = parseRoute(route);
  return {
    localConnection: parsed === "auto",
    reusableSocket: true,
  };
}
