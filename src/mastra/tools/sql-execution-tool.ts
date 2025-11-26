import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { Client } from 'pg';

const createDatabaseConnection = (connectionString: string) => {
  return new Client({
    connectionString,
    connectionTimeoutMillis: 30000, // 30 seconds
    statement_timeout: 60000, // 1 minute
    query_timeout: 60000, // 1 minute
  });
};

const executeQuery = async (client: Client, query: string) => {
  try {
    console.log('Executing query:', query);
    const result = await client.query(query);
    console.log('Query result:', result.rows);
    return result.rows;
  } catch (error) {
    throw new Error(`Failed to execute query: ${error instanceof Error ? error.message : String(error)}`);
  }
};

export const sqlExecutionTool = createTool({
  id: 'sql-execution',
  inputSchema: z.object({
    connectionString: z.string().optional().describe('PostgreSQL connection string. If not provided, will use NEWS_DATABASE_URL from environment variables.'),
    query: z.string().describe('SQL query to execute'),
  }),
  description: 'Executes SQL queries against a PostgreSQL database. Uses NEWS_DATABASE_URL if connectionString is not provided.',
  execute: async ({ context: { connectionString, query } }) => {
    // Use NEWS_DATABASE_URL as fallback if connectionString is not provided
    const dbUrl = connectionString || process.env.NEWS_DATABASE_URL;
    if (!dbUrl) {
      throw new Error('No connection string provided and NEWS_DATABASE_URL is not set in environment variables');
    }
    const client = createDatabaseConnection(dbUrl);

    try {
      console.log('🔌 Connecting to PostgreSQL for query execution...');
      await client.connect();
      console.log('✅ Connected to PostgreSQL for query execution');

      const trimmedQuery = query.trim().toLowerCase();
      if (!trimmedQuery.startsWith('select')) {
        throw new Error('Only SELECT queries are allowed for security reasons');
      }

      const result = await executeQuery(client, query);

      return {
        success: true,
        data: result,
        rowCount: result.length,
        executedQuery: query,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        executedQuery: query,
      };
    } finally {
      await client.end();
    }
  },
});
