# TrailBase Collection Playground

Interactive visual testing environment for TrailBase collection functionality. This playground allows developers to manually verify the test scenarios that fail due to test isolation issues in the automated suite.

## Purpose

The e2e test suite has 4 tests that pass when run individually but fail when run in the full suite due to test-to-test interference. This playground provides a way to manually verify these scenarios work correctly.

## Prerequisites

1. **TrailBase Server**: You need a running TrailBase instance with the test schema.

   ```bash
   # From the trailbase-db-collection directory
   npm run test:e2e:setup  # Or start TrailBase manually
   ```

2. **Test Tables**: The following tables must exist:
   - `users_e2e`
   - `posts_e2e`
   - `comments_e2e`

## Usage

1. **Start TrailBase** (if not already running):
   ```bash
   cd packages/trailbase-db-collection
   npm run test:e2e:setup
   ```

2. **Open the playground**:
   ```bash
   # Option 1: Open directly in browser
   open playground/index.html

   # Option 2: Serve with a simple HTTP server
   npx serve playground
   ```

3. **Connect to TrailBase**:
   - Enter the TrailBase server URL (default: `http://localhost:4000`)
   - Click "Connect"

4. **Seed Data**:
   - Click "Seed Data" to populate the tables with 100 users, 100 posts, and 100 comments
   - This matches the exact seed data used in the e2e tests

5. **Run Tests**:
   - Click "Run Test" on any test card to execute that scenario
   - Results are displayed in real-time with success/failure indicators

## Test Scenarios

### 1. Multi-column orderBy: Subsequent Pages
Creates two queries with the same orderBy (`isActive desc, age asc`) but different limits (15 and 30). Verifies the first 15 items are identical in both results.

### 2. Multi-column orderBy: Mixed Directions
Queries posts with `orderBy(userId asc, viewCount desc)` and limit 20. Verifies userId is ascending, and within the same userId, viewCount is descending.

### 3. setWindow: Mixed Direction OrderBy
Creates a query on posts with mixed direction orderBy, then simulates pagination using offset. Verifies the second page maintains correct ordering and has no overlap with the first page.

### 4. Mutations: Insert Appearing in Query
Creates a query filtering users by age, inserts a new user matching the predicate, and verifies the new user appears in the results.

## Why These Tests Fail in the Suite

These tests pass individually because each run starts with fresh collection state. In the full suite:

1. **Shared Collection State**: Collections persist between tests with cached data
2. **DeduplicatedLoadSubset**: The deduplication layer remembers what data was loaded
3. **Timing Differences**: TrailBase's subscription sync is slower than Electric's shape streaming

The playground demonstrates that the functionality itself works correctly - the issue is purely test isolation.

## Schema

```sql
-- users_e2e
CREATE TABLE users_e2e (
  id BLOB PRIMARY KEY,  -- UUID as base64
  name TEXT NOT NULL,
  email TEXT,
  age INTEGER NOT NULL,
  isActive INTEGER NOT NULL,  -- 0 or 1
  createdAt TEXT NOT NULL,    -- ISO date
  metadata TEXT,              -- JSON
  deletedAt TEXT
);

-- posts_e2e
CREATE TABLE posts_e2e (
  id BLOB PRIMARY KEY,
  userId TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT,
  viewCount INTEGER NOT NULL,
  largeViewCount TEXT NOT NULL,  -- BigInt as string
  publishedAt TEXT,
  deletedAt TEXT
);

-- comments_e2e
CREATE TABLE comments_e2e (
  id BLOB PRIMARY KEY,
  postId TEXT NOT NULL,
  userId TEXT NOT NULL,
  text TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  deletedAt TEXT
);
```
