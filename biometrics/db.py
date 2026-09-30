from datetime import datetime
from typing import List
import atexit
import json
import math
import os
import numpy as np
import pandas as pd
import sqlite3

from data_types import *
from get_logger import *

logger = get_logger()

DB_FILE_PATH = f'{logger.folder_path}free-sleep.db'

# Retention mirrors server defaults (env overrides supported)
VITALS_RETENTION_DAYS = int(os.getenv('FREE_SLEEP_VITALS_RETENTION_DAYS', '30'))
MOVEMENT_RETENTION_DAYS = int(os.getenv('FREE_SLEEP_MOVEMENT_RETENTION_DAYS', '30'))
SNORE_RETENTION_DAYS = int(os.getenv('FREE_SLEEP_SNORE_RETENTION_DAYS', '30'))
SLEEP_RETENTION_DAYS = int(os.getenv('FREE_SLEEP_SLEEP_RETENTION_DAYS', '180'))

# Create a persistent connection
conn = sqlite3.connect(DB_FILE_PATH, isolation_level=None, check_same_thread=False)
conn.execute("PRAGMA journal_mode=WAL;")  # Enable WAL mode
conn.execute("PRAGMA busy_timeout=5000;")  # Wait up to 5 seconds if locked
conn.execute("PRAGMA synchronous=NORMAL;")
conn.execute("PRAGMA foreign_keys=ON;")

def _checkpoint_and_close():
    try:
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE);")
    finally:
        conn.close()


atexit.register(_checkpoint_and_close)


def _is_disk_full_error(error: Exception) -> bool:
    message = str(error).lower()
    return 'full' in message or 'database or disk is full' in message or getattr(error, 'sqlite_errorcode', None) == 13


def prune_old_metrics(
    vitals_days: int = None,
    movement_days: int = None,
    snore_days: int = None,
    sleep_days: int = None,
) -> dict:
    """
    Delete aged high-volume rows so inserts can succeed when the Pod disk is tight.
    Safe to call from the stream process on SQLITE_FULL.
    """
    vitals_days = VITALS_RETENTION_DAYS if vitals_days is None else vitals_days
    movement_days = MOVEMENT_RETENTION_DAYS if movement_days is None else movement_days
    snore_days = SNORE_RETENTION_DAYS if snore_days is None else snore_days
    sleep_days = SLEEP_RETENTION_DAYS if sleep_days is None else sleep_days

    now = datetime.now().timestamp()
    vitals_cutoff = int(now - vitals_days * 86400)
    movement_cutoff = int(now - movement_days * 86400)
    snore_cutoff = int(now - snore_days * 86400)
    sleep_cutoff = int(now - sleep_days * 86400)

    cursor = conn.cursor()
    result = {'vitals': 0, 'movement': 0, 'snore': 0, 'sleep_records': 0}
    try:
        logger.warning(
            f'Pruning metrics: vitals<{vitals_days}d movement<{movement_days}d '
            f'snore<{snore_days}d sleep<{sleep_days}d'
        )
        cursor.execute('DELETE FROM vitals WHERE timestamp < ?', (vitals_cutoff,))
        result['vitals'] = cursor.rowcount if cursor.rowcount is not None else 0
        cursor.execute('DELETE FROM movement WHERE timestamp < ?', (movement_cutoff,))
        result['movement'] = cursor.rowcount if cursor.rowcount is not None else 0
        try:
            cursor.execute('DELETE FROM snore WHERE timestamp < ?', (snore_cutoff,))
            result['snore'] = cursor.rowcount if cursor.rowcount is not None else 0
        except sqlite3.Error:
            result['snore'] = 0
        cursor.execute('DELETE FROM sleep_records WHERE entered_bed_at < ?', (sleep_cutoff,))
        result['sleep_records'] = cursor.rowcount if cursor.rowcount is not None else 0
        try:
            cursor.execute('PRAGMA wal_checkpoint(TRUNCATE)')
            cursor.execute('VACUUM')
        except sqlite3.Error as vacuum_error:
            logger.warning(f'VACUUM after prune failed (non-fatal): {vacuum_error}')
        logger.warning(f'Prune complete: {result}')
    except sqlite3.Error as error:
        logger.error(f'Prune failed: {error}')
    finally:
        cursor.close()
    return result


def custom_serializer(obj):
    if isinstance(obj, (datetime, pd.Timestamp)):
        return obj.isoformat()  # Convert to ISO 8601 format
    raise TypeError(f"Type {type(obj)} not serializable")


def convert_timestamps(data: List[SleepRecord]) -> List[SleepRecord]:
    formatted_data = []
    for entry in data:
        formatted_entry: SleepRecord = {
            "side": entry["side"],
            "entered_bed_at": datetime.fromisoformat(entry["entered_bed_at"]),
            "left_bed_at": datetime.fromisoformat(entry["left_bed_at"]),
            "sleep_period_seconds": entry["sleep_period_seconds"],
            "times_exited_bed": entry["times_exited_bed"],
            "present_intervals": [
                (datetime.fromisoformat(start), datetime.fromisoformat(end))
                for start, end in entry["present_intervals"]
            ],
            "not_present_intervals": [
                (datetime.fromisoformat(start), datetime.fromisoformat(end))
                for start, end in entry["not_present_intervals"]
            ]
        }
        formatted_data.append(formatted_entry)
    return formatted_data


def insert_vitals(data: dict):
    """
    Inserts a record into the 'vitals' table. If a conflict occurs, it skips the insertion.
    """
    cursor = conn.cursor()

    sql = """
    INSERT INTO vitals (side, timestamp, heart_rate, hrv, breathing_rate)
    VALUES (:side, :timestamp, :heart_rate, :hrv, :breathing_rate)
    ON CONFLICT(side, timestamp) DO NOTHING;
    """
    if np.isnan(data['hrv']):
        data['hrv'] = 0
    else:
        data['hrv'] = math.floor(data['hrv'])

    if np.isnan(data['breathing_rate']):
        data['breathing_rate'] = 0
    else:
        data['breathing_rate'] = math.floor(data['breathing_rate'])

    data['heart_rate'] = math.floor(data['heart_rate'])
    logger.debug('Inserting vitals record...')
    try:
        cursor.execute(sql, data)
    except sqlite3.Error as error:
        logger.error(error)
        if _is_disk_full_error(error):
            # Free space and retry once so the stream can keep running
            logger.warning('Disk/database full on vitals insert — running emergency prune')
            prune_old_metrics(
                vitals_days=max(7, VITALS_RETENTION_DAYS // 2),
                movement_days=max(7, MOVEMENT_RETENTION_DAYS // 2),
                snore_days=max(7, SNORE_RETENTION_DAYS // 2),
            )
            try:
                cursor.execute(sql, data)
                logger.info('Vitals insert succeeded after emergency prune')
            except sqlite3.Error as retry_error:
                logger.error(f'Vitals insert still failing after prune: {retry_error}')
    finally:
        cursor.close()


def insert_sleep_records(sleep_records: List[SleepRecord]):
    """
    Inserts a list of records into the sleep_records table in the given database.
    Each record is expected to have:
      - side (str)
      - entered_bed_at (datetime)
      - left_bed_at (datetime, optional)
      - sleep_period_seconds (int)
      - times_exited_bed (int)
      - present_intervals (list of [start, end] datetime pairs)
      - not_present_intervals (list of [start, end] datetime pairs)
    """
    try:
        cursor = conn.cursor()

        if len(sleep_records) == 0:
            logger.warning(f'No sleep records to insert, exiting...')
            return
        else:
            logger.info(f'Inserting {len(sleep_records)} sleep record(s) into {DB_FILE_PATH}...')
            logger.info(json.dumps(sleep_records, indent=4, default=custom_serializer))

        insert_query = """
        INSERT OR IGNORE INTO sleep_records (
            side,
            entered_bed_at,
            left_bed_at,
            sleep_period_seconds,
            times_exited_bed,
            present_intervals,
            not_present_intervals
        ) VALUES (?, ?, ?, ?, ?, ?, ?);
        """

        # Convert records to tuples for insertion
        values_to_insert = []
        for sleep_record in sleep_records:
            side = sleep_record['side']
            entered_bed_at = int(sleep_record['entered_bed_at'].timestamp())
            left_bed_at = int(sleep_record.get('left_bed_at').timestamp())
            sleep_period_seconds = sleep_record.get('sleep_period_seconds', 0)
            times_exited_bed = sleep_record.get('times_exited_bed', 0)

            # Encode intervals as JSON strings
            present_intervals_str = json.dumps([
                [int(start.timestamp()), int(end.timestamp())] for start, end in sleep_record.get('present_intervals', [])
            ])
            not_present_intervals_str = json.dumps([
                [int(start.timestamp()), int(end.timestamp())] for start, end in sleep_record.get('not_present_intervals', [])
            ])

            # Prepare the data tuple
            row_tuple = (
                side,
                entered_bed_at,
                left_bed_at,
                sleep_period_seconds,
                times_exited_bed,
                present_intervals_str,
                not_present_intervals_str
            )
            values_to_insert.append(row_tuple)

        cursor.executemany(insert_query, values_to_insert)
        logger.info(f"Inserted {len(sleep_records)} record(s) into 'sleep_records' (ignoring duplicates).")
    except Exception as error:
        logger.error(error)
    finally:
        cursor.close()



def insert_movement_df(movement_df: pd.DataFrame):
    """
    Upsert movement rows. Re-running analyze_sleep for the same night must not
    fail on UNIQUE(side, timestamp).
    """
    try:
        if movement_df is None or movement_df.empty:
            logger.debug('No movement rows to insert')
            return

        logger.debug(f'Inserting {movement_df.shape[0]} rows into movement table...')
        df = movement_df.copy()
        df['timestamp'] = pd.to_datetime(df['timestamp']).astype(int) // 10 ** 9

        if 'side' not in df.columns or 'timestamp' not in df.columns:
            logger.error(f'movement_df missing side/timestamp columns: {list(df.columns)}')
            return

        # Drop existing rows in this side+time range so re-analysis is idempotent
        side = str(df['side'].iloc[0])
        ts_min = int(df['timestamp'].min())
        ts_max = int(df['timestamp'].max())
        cursor = conn.cursor()
        cursor.execute(
            'DELETE FROM movement WHERE side = ? AND timestamp >= ? AND timestamp <= ?',
            (side, ts_min, ts_max),
        )
        deleted = cursor.rowcount if cursor.rowcount is not None else 0
        if deleted:
            logger.debug(f'Removed {deleted} existing movement row(s) for {side} before re-insert')
        cursor.close()

        df.to_sql('movement', conn, if_exists='append', index=False)
        logger.debug('Finished inserting movement rows')

    except Exception as error:
        logger.error('Failed to insert movement df!')
        logger.error(error)
        if _is_disk_full_error(error):
            logger.warning('Disk/database full on movement insert — running emergency prune')
            prune_old_metrics(
                vitals_days=max(7, VITALS_RETENTION_DAYS // 2),
                movement_days=max(7, MOVEMENT_RETENTION_DAYS // 2),
                snore_days=max(7, SNORE_RETENTION_DAYS // 2),
            )
            try:
                movement_df_retry = movement_df.copy()
                movement_df_retry['timestamp'] = (
                    pd.to_datetime(movement_df_retry['timestamp']).astype(int) // 10 ** 9
                )
                movement_df_retry.to_sql('movement', conn, if_exists='append', index=False)
                logger.info('Movement insert succeeded after emergency prune')
            except Exception as retry_error:
                logger.error(f'Movement insert still failing after prune: {retry_error}')


def ensure_snore_schema():
    """
    Create snore table + sleep_records.snore_minutes if missing.

    Safe to call before first insert (Pod dry-run before prisma migrate deploy).
    Values are a piezo spectral heuristic — not OEM ML / clinical.
    """
    cursor = conn.cursor()
    try:
        cursor.execute(
            "CREATE TABLE IF NOT EXISTS snore ("
            "id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,"
            "timestamp INTEGER NOT NULL,"
            "side TEXT NOT NULL,"
            "snore INTEGER NOT NULL,"
            "likelihood REAL NOT NULL"
            ");"
        )
        cursor.execute(
            "CREATE INDEX IF NOT EXISTS snore_side_timestamp_idx ON snore(side, timestamp);"
        )
        cursor.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS snore_side_timestamp_key ON snore(side, timestamp);"
        )
        cols = {row[1] for row in cursor.execute("PRAGMA table_info(sleep_records)").fetchall()}
        if "snore_minutes" not in cols:
            cursor.execute("ALTER TABLE sleep_records ADD COLUMN snore_minutes INTEGER;")
            logger.info("Added sleep_records.snore_minutes column (heuristic total)")
    finally:
        cursor.close()


def insert_snore_df(snore_df: pd.DataFrame):
    """
    Upsert per-minute snore heuristic rows (mirrors insert_movement_df).

    Columns: timestamp (unix s), side, snore (0/1), likelihood (float).
    """
    try:
        if snore_df is None or snore_df.empty:
            logger.debug("No snore rows to insert")
            return

        ensure_snore_schema()
        logger.debug(f"Inserting {snore_df.shape[0]} rows into snore table (heuristic)...")
        df = snore_df.copy()
        if "timestamp" not in df.columns or "side" not in df.columns:
            logger.error(f"snore_df missing side/timestamp columns: {list(df.columns)}")
            return
        df["timestamp"] = df["timestamp"].astype(int)
        df["snore"] = df["snore"].astype(int)
        df["likelihood"] = df["likelihood"].astype(float)

        side = str(df["side"].iloc[0])
        ts_min = int(df["timestamp"].min())
        ts_max = int(df["timestamp"].max())
        cursor = conn.cursor()
        cursor.execute(
            "DELETE FROM snore WHERE side = ? AND timestamp >= ? AND timestamp <= ?",
            (side, ts_min, ts_max),
        )
        deleted = cursor.rowcount if cursor.rowcount is not None else 0
        if deleted:
            logger.debug(f"Removed {deleted} existing snore row(s) for {side} before re-insert")
        cursor.close()

        df[["timestamp", "side", "snore", "likelihood"]].to_sql(
            "snore", conn, if_exists="append", index=False
        )
        logger.debug("Finished inserting snore rows")
    except Exception as error:
        logger.error("Failed to insert snore df!")
        logger.error(error)
        if _is_disk_full_error(error):
            logger.warning("Disk/database full on snore insert — running emergency prune")
            prune_old_metrics(
                vitals_days=max(7, VITALS_RETENTION_DAYS // 2),
                movement_days=max(7, MOVEMENT_RETENTION_DAYS // 2),
                snore_days=max(7, SNORE_RETENTION_DAYS // 2),
            )
            try:
                ensure_snore_schema()
                snore_df_retry = snore_df.copy()
                snore_df_retry["timestamp"] = snore_df_retry["timestamp"].astype(int)
                snore_df_retry[["timestamp", "side", "snore", "likelihood"]].to_sql(
                    "snore", conn, if_exists="append", index=False
                )
                logger.info("Snore insert succeeded after emergency prune")
            except Exception as retry_error:
                logger.error(f"Snore insert still failing after prune: {retry_error}")


def update_sleep_record_snore_minutes(
    sleep_id,
    snore_minutes: int,
    *,
    side: str = None,
    entered_bed_at: int = None,
):
    """
    Store night-level heuristic snore minute total on sleep_records.

    Prefer id; fall back to (side, entered_bed_at) unique key.
    """
    try:
        ensure_snore_schema()
        cursor = conn.cursor()
        if sleep_id is not None:
            cursor.execute(
                "UPDATE sleep_records SET snore_minutes = ? WHERE id = ?",
                (int(snore_minutes), int(sleep_id)),
            )
        elif side is not None and entered_bed_at is not None:
            cursor.execute(
                "UPDATE sleep_records SET snore_minutes = ? WHERE side = ? AND entered_bed_at = ?",
                (int(snore_minutes), side, int(entered_bed_at)),
            )
        else:
            logger.warning("update_sleep_record_snore_minutes: no id or side/entered_bed_at")
            cursor.close()
            return
        logger.debug(
            f"Updated sleep_records.snore_minutes={snore_minutes} "
            f"(id={sleep_id}, side={side}, entered={entered_bed_at}) [heuristic]"
        )
        cursor.close()
    except Exception as error:
        logger.error(f"Failed to update sleep_records.snore_minutes: {error}")
