import { Client, Pool } from "pg";

function forbidden(): never {
  throw new Error("Database access is forbidden in unit tests. Mock the database boundary or classify this test as integration.");
}
Pool.prototype.connect = forbidden;
Pool.prototype.query = forbidden;
Client.prototype.connect = forbidden;
Client.prototype.query = forbidden;
