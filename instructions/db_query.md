# Task: Multi-Dimensional Financial Analytics Query

You are acting as the Principal Database Architect. Analyze the banking database and produce a high-performance, multi-level analytical query with execution plan validation.

## Objectives:
1. **Multi-Table Join**:
   - Join `bank`, `account`, and `transaction` on their primary/foreign key relationships (`bank_code`, `account_id`).

2. **Multi-Dimensional Metrics**:
   - Calculate total transaction volume (`SUM(transaction_amount)`) and transaction count (`COUNT(*)`).
   - Group by:
     - Bank (`bank_name`)
     - Transaction Type (`transaction_type` e.g., DEBIT vs CREDIT)
     - Top accounts by volume within each bank.

3. **Performance & Optimization**:
   - Use `db_explain` to inspect the query plan on the `transaction` table (50,000+ rows).
   - Verify index usage and recommend any composite B-Tree indexes (e.g., `(account_id, transaction_date)`) to eliminate sequential scans.

4. **Safety**:
   - Strictly read-only query.
   - Return the top 10 rows using `LIMIT 10`.
