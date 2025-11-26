import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { openai } from '@ai-sdk/openai';
import { generateObject } from 'ai';

// Forbidden columns that must never be selected from the articles table
const FORBIDDEN_COLUMNS = ['content', 'body', 'full_text', 'html', 'raw_content'];
const ALLOWED_COLUMNS = ['id', 'title', 'slug', 'symbols', 'url', 'published_at'];
const ARTICLES_TABLE_NAME = 'articles';

// Helper function to check if a SQL query contains forbidden columns
function containsForbiddenColumns(sql: string): { hasForbidden: boolean; forbiddenColumns: string[] } {
  const sqlLower = sql.toLowerCase();
  const foundForbidden: string[] = [];

  // Check for forbidden columns in SELECT clause
  // Match patterns like: SELECT content, SELECT articles.content, SELECT "content", etc.
  const selectMatch = sqlLower.match(/select\s+([^from]+?)\s+from/i);
  if (selectMatch) {
    const selectClause = selectMatch[1];
    FORBIDDEN_COLUMNS.forEach((col) => {
      // Check for column name (with word boundaries to avoid partial matches)
      const regex = new RegExp(`\\b${col}\\b`, 'i');
      if (regex.test(selectClause)) {
        foundForbidden.push(col);
      }
    });
  }

  return {
    hasForbidden: foundForbidden.length > 0,
    forbiddenColumns: foundForbidden,
  };
}

// Helper function to sanitize SQL by removing forbidden columns from SELECT clause
function sanitizeSQL(sql: string): string {
  const sqlLower = sql.toLowerCase();
  const selectMatch = sql.match(/select\s+([^from]+?)\s+from/i);
  
  if (!selectMatch) {
    return sql; // Return as-is if we can't parse it
  }

  const originalSelect = selectMatch[1];
  const selectClause = originalSelect;
  
  // Split by comma and filter out forbidden columns
  const columns = selectClause.split(',').map((col) => col.trim());
  const sanitizedColumns = columns.filter((col) => {
    const colLower = col.toLowerCase();
    // Remove table qualifiers and quotes for comparison
    const colName = colLower
      .replace(/^[\w.]+\./, '') // Remove table prefix
      .replace(/^["']|["']$/g, '') // Remove quotes
      .trim();
    
    return !FORBIDDEN_COLUMNS.includes(colName);
  });

  if (sanitizedColumns.length === 0) {
    // If all columns were removed, add allowed columns as fallback
    sanitizedColumns.push(...ALLOWED_COLUMNS);
  }

  // Reconstruct the SQL with sanitized columns
  const sanitizedSelect = sanitizedColumns.join(', ');
  return sql.replace(/select\s+[^from]+?\s+from/i, `SELECT ${sanitizedSelect} FROM`);
}

// Define the schema for SQL generation output
const sqlGenerationSchema = z.object({
  sql: z.string().describe('The generated SQL query'),
  explanation: z.string().describe('Explanation of what the query does'),
  confidence: z.number().min(0).max(1).describe('Confidence level in the generated query (0-1)'),
  assumptions: z.array(z.string()).describe('Any assumptions made while generating the query'),
  tables_used: z.array(z.string()).describe('List of tables used in the query'),
});

export const sqlGenerationTool = createTool({
  id: 'sql-generation',
  inputSchema: z.object({
    naturalLanguageQuery: z.string().describe('Natural language query from the user'),
    databaseSchema: z.object({
      tables: z.array(
        z.object({
          schema_name: z.string(),
          table_name: z.string(),
          table_owner: z.string(),
        }),
      ),
      columns: z.array(
        z.object({
          table_schema: z.string(),
          table_name: z.string(),
          column_name: z.string(),
          data_type: z.string(),
          character_maximum_length: z.number().nullable(),
          numeric_precision: z.number().nullable(),
          numeric_scale: z.number().nullable(),
          is_nullable: z.string(),
          column_default: z.string().nullable(),
          is_primary_key: z.boolean(),
        }),
      ),
      relationships: z.array(
        z.object({
          table_schema: z.string(),
          table_name: z.string(),
          column_name: z.string(),
          foreign_table_schema: z.string(),
          foreign_table_name: z.string(),
          foreign_column_name: z.string(),
          constraint_name: z.string(),
        }),
      ),
      indexes: z.array(
        z.object({
          schema_name: z.string(),
          table_name: z.string(),
          index_name: z.string(),
          index_definition: z.string(),
        }),
      ),
      rowCounts: z.array(
        z.object({
          schema_name: z.string(),
          table_name: z.string(),
          row_count: z.number(),
          error: z.string().optional(),
        }),
      ),
    }),
  }),
  description: 'Generates SQL queries from natural language descriptions using database schema information',
  execute: async ({ context: { naturalLanguageQuery, databaseSchema } }) => {
    try {
      console.log('🔌 Generating SQL query for:', naturalLanguageQuery);
      // Create a comprehensive schema description for the AI
      const schemaDescription = createSchemaDescription(databaseSchema);

      const systemPrompt = `You are an expert PostgreSQL query generator. Your task is to convert natural language questions into accurate SQL queries.

DATABASE SCHEMA:
${schemaDescription}

CRITICAL RULE - CONTENT COLUMN RESTRICTION:
⚠️ NEVER SELECT THE "content" COLUMN OR RELATED TEXT COLUMNS FROM THE "articles" TABLE ⚠️

When querying the "articles" table (or any table named "articles"), you MUST NOT select or reference these forbidden columns:
- content
- body
- full_text
- html
- raw_content
- (or any column that contains long article text)

You are ONLY allowed to query these columns from the "articles" table (in this order):
- id
- title
- slug
- symbols
- url
- published_at

If a user asks for article details or summaries, you must NOT fetch the "content" column. Instead, rely on:
- title
- slug
- summary (if exists)
- metadata
- or simply indicate that detailed content is not available in the database

ALWAYS generate SQL in this pattern for the "articles" table:

**General articles query:**
SELECT id, title, slug, symbols, url, published_at
FROM articles
ORDER BY published_at DESC
LIMIT 10;

**Stock-specific query (when filtering by stock symbol):**
SELECT id, title, slug, symbols, url, published_at
FROM articles
WHERE symbols @> ARRAY['STOCK_CODE']::text[]
ORDER BY published_at DESC
LIMIT 10;

CRITICAL: Every query for the "articles" table MUST include LIMIT 10. This is mandatory.

For stock-specific queries: When the user asks about a specific stock code (e.g., "FPT", "VPB", "VCB"), you MUST use the exact condition: WHERE symbols @> ARRAY['STOCK_CODE']::text[] where STOCK_CODE is replaced with the actual stock code from the user's query.

Never include "content" in SELECT, WHERE, or any query part when working with the "articles" table.

RULES:
1. Only generate SELECT queries for data retrieval
2. Use proper PostgreSQL syntax
3. Always qualify column names with table names when joining tables
4. Use appropriate JOINs when data from multiple tables is needed
5. Be case-insensitive for text searches using ILIKE
6. Use proper data types for comparisons
7. Format queries with proper indentation and line breaks
8. Include appropriate WHERE clauses to filter results
9. CRITICAL: For "articles" table queries, ALWAYS include LIMIT 10 (this is mandatory)
10. CRITICAL: For stock-specific queries on "articles" table, use WHERE symbols @> ARRAY['STOCK_CODE']::text[] (replace STOCK_CODE with the actual stock code)
11. Consider performance implications of the query

QUERY ANALYSIS:
- Analyze the user's question carefully
- Identify which tables and columns are needed
- Determine if joins are required
- Consider aggregation functions if needed
- Think about appropriate filtering conditions
- Consider ordering and limiting results
- CRITICAL: If querying "articles" table, only use allowed columns (id, title, slug, symbols, url, published_at) and ALWAYS include LIMIT 10
- CRITICAL: If filtering by stock symbol in "articles" table, use WHERE symbols @> ARRAY['STOCK_CODE']::text[] where STOCK_CODE is the actual stock code from the user's query

Provide a high-confidence SQL query that accurately answers the user's question.`;

      const userPrompt = `Generate a SQL query for this question: "${naturalLanguageQuery}"

Please provide:
1. The SQL query
2. A clear explanation of what the query does
3. Your confidence level (0-1)
4. Any assumptions you made
5. List of tables used`;

      // Get model from environment or use default
      const modelString = process.env.MODEL || 'gpt-4o';
      // Extract model name if it includes provider prefix (e.g., 'openai/gpt-4o' -> 'gpt-4o')
      const modelName = modelString.includes('/') ? modelString.split('/')[1] : modelString;

      const result = await generateObject({
        model: openai(modelName) as any,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        schema: sqlGenerationSchema,
        temperature: 0.1, // Low temperature for more deterministic results
      });

      // Validate and sanitize the generated SQL
      const generatedSQL = result.object.sql;
      const validation = containsForbiddenColumns(generatedSQL);
      
      if (validation.hasForbidden) {
        console.warn(`⚠️ Generated SQL contains forbidden columns: ${validation.forbiddenColumns.join(', ')}. Sanitizing...`);
        const sanitizedSQL = sanitizeSQL(generatedSQL);
        
        // Update the result with sanitized SQL
        return {
          ...result.object,
          sql: sanitizedSQL,
          explanation: `${result.object.explanation} [Note: Forbidden columns (${validation.forbiddenColumns.join(', ')}) were automatically removed from the query.]`,
          assumptions: [
            ...result.object.assumptions,
            `Forbidden columns (${validation.forbiddenColumns.join(', ')}) were detected and removed from the SELECT clause.`,
          ],
        };
      }

      return result.object;
    } catch (error) {
      throw new Error(`Failed to generate SQL query: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});

function createSchemaDescription(databaseSchema: any): string {
  let description = '';

  // Group columns by table
  const tableColumns = new Map<string, any[]>();
  databaseSchema.columns.forEach((column: any) => {
    const tableKey = `${column.table_schema}.${column.table_name}`;
    if (!tableColumns.has(tableKey)) {
      tableColumns.set(tableKey, []);
    }
    tableColumns.get(tableKey)?.push(column);
  });

  // Create table descriptions
  databaseSchema.tables.forEach((table: any) => {
    const tableKey = `${table.schema_name}.${table.table_name}`;
    const columns = tableColumns.get(tableKey) || [];
    const rowCount = databaseSchema.rowCounts.find(
      (rc: any) => rc.schema_name === table.schema_name && rc.table_name === table.table_name,
    );

    const isArticlesTable = table.table_name.toLowerCase() === ARTICLES_TABLE_NAME.toLowerCase();
    
    description += `\nTable: ${table.schema_name}.${table.table_name}`;
    if (rowCount) {
      description += ` (${rowCount.row_count} rows)`;
    }
    
    if (isArticlesTable) {
      description += '\n⚠️ RESTRICTED TABLE - Content column access is forbidden ⚠️';
      description += '\nAllowed columns only: id, title, slug, symbols, url, published_at';
      description += '\nForbidden columns: content, body, full_text, html, raw_content (and any long text columns)';
      description += '\nMANDATORY: Every query MUST include LIMIT 10';
    }
    
    description += '\nColumns:\n';

    columns.forEach((column: any) => {
      // Skip forbidden columns when describing the articles table
      if (isArticlesTable && FORBIDDEN_COLUMNS.includes(column.column_name.toLowerCase())) {
        description += `  - ${column.column_name}: ${column.data_type} [FORBIDDEN - DO NOT SELECT]`;
      } else {
        description += `  - ${column.column_name}: ${column.data_type}`;
        if (column.character_maximum_length) {
          description += `(${column.character_maximum_length})`;
        }
        if (column.is_primary_key) {
          description += ' [PRIMARY KEY]';
        }
        if (column.is_nullable === 'NO') {
          description += ' [NOT NULL]';
        }
        if (column.column_default) {
          description += ` [DEFAULT: ${column.column_default}]`;
        }
      }
      description += '\n';
    });
  });

  // Add relationship information
  if (databaseSchema.relationships.length > 0) {
    description += '\nRelationships:\n';
    databaseSchema.relationships.forEach((rel: any) => {
      description += `  - ${rel.table_schema}.${rel.table_name}.${rel.column_name} → ${rel.foreign_table_schema}.${rel.foreign_table_name}.${rel.foreign_column_name}\n`;
    });
  }

  // Add index information
  if (databaseSchema.indexes.length > 0) {
    description += '\nIndexes:\n';
    databaseSchema.indexes.forEach((index: any) => {
      description += `  - ${index.schema_name}.${index.table_name}: ${index.index_name}\n`;
    });
  }

  return description;
}
