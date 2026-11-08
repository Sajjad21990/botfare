/** TEST_DATABASE_URL, falling back to the docker-compose test database. */
export function testDatabaseUrl(): string {
  return process.env.TEST_DATABASE_URL ?? "postgres://botfare:botfare@localhost:5432/botfare_test";
}
