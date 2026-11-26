/** The address of a database of people's own, from the environment, in place of `--database`. */
export const DATABASE_VARIABLE = "AQ_DATABASE_URL";

const hasPassword = (address: string) => {
  try {
    return new URL(address).password !== "";
  } catch {
    return false;
  }
};

/**
 * The address of the database to use, and what people are to be told about how they gave it. The
 * environment variable is better than `--database`, as what is in a command line others of the
 * computer can read (the process list); it is taken out of the environment at once, so no program
 * started later gets it. Where both are given, `--database` wins, the one given on purpose now.
 */
export function databaseFrom(
  option: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { readonly database: string | undefined; readonly warning?: string } {
  const fromEnvironment = env[DATABASE_VARIABLE] || undefined;
  delete env[DATABASE_VARIABLE];
  const database = option ?? fromEnvironment;
  if (option !== undefined && hasPassword(option))
    return {
      database,
      warning: `提醒：--database 里的密码，同一台电脑上的其他用户能看到（在进程列表里）。改用环境变量 ${DATABASE_VARIABLE} 给这个网址。`,
    };
  return { database };
}
