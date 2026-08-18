export type ServiceHealth = {
  status: "ok";
  service: string;
  api_version: string;
  schema_version: number;
};

export type ServiceConnection =
  | { state: "checking" }
  | { state: "online"; health: ServiceHealth }
  | { state: "offline" };

export async function fetchServiceHealth(signal?: AbortSignal): Promise<ServiceHealth> {
  const response = await fetch("/api/health", { signal });
  if (!response.ok) throw new Error(`Health request failed with ${response.status}`);

  const health = await response.json() as ServiceHealth;
  if (health.status !== "ok" || typeof health.schema_version !== "number") {
    throw new Error("Health response is invalid");
  }
  return health;
}
