module.exports = {
  schema: "./lib/db/schema.ts",
  out: "./db/migrations",
  driver: "better-sqlite",
  dbCredentials: {
    url: process.env.DB_PATH || "./db/gsplayer.sqlite",
  },
};
