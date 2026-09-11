declare global {
  namespace NodeJS {
    interface ProcessEnv {
      UPTIMEFLARE_CONFIG: KVNamespace
      UPTIMEFLARE_D1: D1Database
    }
  }
}

export {}
