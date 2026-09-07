"""Bus attendance - Flask backend.

Stores students (with face descriptors computed in the browser) and daily
attendance records in SQLite, and exports attendance as Excel or PDF.
"""
import io
import json
import os
import re
import sqlite3
from datetime import date, datetime

from flask import Flask, g, jsonify, request, send_file, send_from_directory

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(BASE_DIR, "data"))
os.makedirs(DATA_DIR, exist_ok=True)
DB_PATH = os.path.join(DATA_DIR, "attendance.db")

app = Flask(__name__, static_folder="static", static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = 8 * 1024 * 1024  # photos are small thumbnails

DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


# --------------------------------------------------------------------------- db
def get_db():
    if "db" not in g:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        g.db = conn
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS students (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            student_no  TEXT NOT NULL UNIQUE,
            name        TEXT NOT NULL,
            grade       TEXT NOT NULL DEFAULT '',
            photo       TEXT NOT NULL DEFAULT '',
            descriptors TEXT NOT NULL DEFAULT '[]',
            created_at  TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS attendance (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
            day        TEXT NOT NULL,
            time       TEXT NOT NULL,
            method     TEXT NOT NULL DEFAULT 'face',
            UNIQUE(student_id, day)
        );
        CREATE INDEX IF NOT EXISTS idx_attendance_day ON attendance(day);
        """
    )
    conn.commit()
    conn.close()


init_db()


# ---------------------------------------------------------------------- helpers
def today_str():
    return date.today().isoformat()


def valid_day(value, default=None):
    if not value:
        return default
    if not DAY_RE.match(value):
        return None
    try:
        date.fromisoformat(value)
    except ValueError:
        return None
    return value


def student_row_to_dict(row, include_descriptors=True):
    data = {
        "id": row["id"],
        "student_no": row["student_no"],
        "name": row["name"],
        "grade": row["grade"],
        "photo": row["photo"],
        "created_at": row["created_at"],
    }
    if include_descriptors:
        data["descriptors"] = json.loads(row["descriptors"] or "[]")
    return data


def clean_descriptors(raw):
    """Accept a list of 128-float vectors; return a JSON string or raise ValueError."""
    if raw is None:
        return "[]"
    if not isinstance(raw, list):
        raise ValueError("descriptors must be a list")
    out = []
    for vec in raw:
        if not isinstance(vec, list) or len(vec) != 128:
            raise ValueError("each descriptor must have 128 numbers")
        out.append([float(x) for x in vec])
    if len(out) > 10:
        out = out[:10]
    return json.dumps(out)


def range_from_args():
    """Read from/to query params. Defaults to the current month."""
    today = date.today()
    default_from = today.replace(day=1).isoformat()
    default_to = today.isoformat()
    start = valid_day(request.args.get("from"), default_from)
    end = valid_day(request.args.get("to"), default_to)
    if start is None or end is None:
        return None, None
    if start > end:
        start, end = end, start
    return start, end


# ---------------------------------------------------------------------- routes
@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/health")
def health():
    return jsonify({"ok": True})


@app.route("/api/students", methods=["GET"])
def list_students():
    db = get_db()
    day = valid_day(request.args.get("date"), today_str())
    rows = db.execute("SELECT * FROM students ORDER BY name COLLATE NOCASE").fetchall()
    present = {
        r["student_id"]: r["time"]
        for r in db.execute("SELECT student_id, time FROM attendance WHERE day = ?", (day,))
    }
    counts = {
        r["student_id"]: r["n"]
        for r in db.execute("SELECT student_id, COUNT(*) AS n FROM attendance GROUP BY student_id")
    }
    students = []
    for row in rows:
        s = student_row_to_dict(row)
        s["present_today"] = row["id"] in present
        s["time_today"] = present.get(row["id"])
        s["total_days"] = counts.get(row["id"], 0)
        students.append(s)
    return jsonify({"date": day, "students": students})


@app.route("/api/students", methods=["POST"])
def create_student():
    payload = request.get_json(silent=True) or {}
    name = (payload.get("name") or "").strip()
    student_no = (payload.get("student_no") or "").strip()
    grade = (payload.get("grade") or "").strip()
    photo = payload.get("photo") or ""
    if not name:
        return jsonify({"error": "Name is required"}), 400
    if not student_no:
        return jsonify({"error": "Student ID is required"}), 400
    if photo and not photo.startswith("data:image/"):
        return jsonify({"error": "Photo must be an image"}), 400
    if len(photo) > 400_000:
        return jsonify({"error": "Photo is too large"}), 400
    try:
        descriptors = clean_descriptors(payload.get("descriptors"))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    db = get_db()
    try:
        cur = db.execute(
            "INSERT INTO students (student_no, name, grade, photo, descriptors, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (student_no, name, grade, photo, descriptors, datetime.now().isoformat(timespec="seconds")),
        )
        db.commit()
    except sqlite3.IntegrityError:
        return jsonify({"error": f"Student ID '{student_no}' already exists"}), 409
    row = db.execute("SELECT * FROM students WHERE id = ?", (cur.lastrowid,)).fetchone()
    s = student_row_to_dict(row)
    s.update({"present_today": False, "time_today": None, "total_days": 0})
    return jsonify(s), 201


@app.route("/api/students/<int:student_id>", methods=["PUT"])
def update_student(student_id):
    payload = request.get_json(silent=True) or {}
    db = get_db()
    row = db.execute("SELECT * FROM students WHERE id = ?", (student_id,)).fetchone()
    if row is None:
        return jsonify({"error": "Student not found"}), 404

    name = (payload.get("name") or row["name"]).strip()
    student_no = (payload.get("student_no") or row["student_no"]).strip()
    grade = (payload.get("grade") if payload.get("grade") is not None else row["grade"]).strip()
    photo = payload.get("photo") if payload.get("photo") is not None else row["photo"]
    if photo and not photo.startswith("data:image/"):
        return jsonify({"error": "Photo must be an image"}), 400
    descriptors = row["descriptors"]
    if "descriptors" in payload:
        try:
            descriptors = clean_descriptors(payload.get("descriptors"))
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
    try:
        db.execute(
            "UPDATE students SET student_no=?, name=?, grade=?, photo=?, descriptors=? WHERE id=?",
            (student_no, name, grade, photo, descriptors, student_id),
        )
        db.commit()
    except sqlite3.IntegrityError:
        return jsonify({"error": f"Student ID '{student_no}' already exists"}), 409
    row = db.execute("SELECT * FROM students WHERE id = ?", (student_id,)).fetchone()
    return jsonify(student_row_to_dict(row))


@app.route("/api/students/<int:student_id>", methods=["DELETE"])
def delete_student(student_id):
    db = get_db()
    cur = db.execute("DELETE FROM students WHERE id = ?", (student_id,))
    db.commit()
    if cur.rowcount == 0:
        return jsonify({"error": "Student not found"}), 404
    return jsonify({"ok": True})


@app.route("/api/students/<int:student_id>/history", methods=["GET"])
def student_history(student_id):
    db = get_db()
    row = db.execute("SELECT * FROM students WHERE id = ?", (student_id,)).fetchone()
    if row is None:
        return jsonify({"error": "Student not found"}), 404
    records = db.execute(
        "SELECT id, day, time, method FROM attendance WHERE student_id = ? ORDER BY day DESC LIMIT 90",
        (student_id,),
    ).fetchall()
    return jsonify(
        {
            "student": student_row_to_dict(row, include_descriptors=False),
            "records": [dict(r) for r in records],
        }
    )


@app.route("/api/attendance", methods=["GET"])
def list_attendance():
    db = get_db()
    day = valid_day(request.args.get("date"), today_str())
    if day is None:
        return jsonify({"error": "Invalid date"}), 400
    rows = db.execute(
        "SELECT a.id, a.day, a.time, a.method, s.id AS student_id, s.student_no, s.name, s.grade, s.photo "
        "FROM attendance a JOIN students s ON s.id = a.student_id "
        "WHERE a.day = ? ORDER BY a.time DESC",
        (day,),
    ).fetchall()
    total = db.execute("SELECT COUNT(*) FROM students").fetchone()[0]
    return jsonify({"date": day, "total_students": total, "records": [dict(r) for r in rows]})


@app.route("/api/attendance", methods=["POST"])
def mark_attendance():
    payload = request.get_json(silent=True) or {}
    student_id = payload.get("student_id")
    if not isinstance(student_id, int):
        return jsonify({"error": "student_id is required"}), 400
    day = valid_day(payload.get("day"), today_str())
    if day is None:
        return jsonify({"error": "Invalid day"}), 400
    time_str = payload.get("time") or datetime.now().strftime("%H:%M:%S")
    if not re.match(r"^\d{2}:\d{2}(:\d{2})?$", str(time_str)):
        time_str = datetime.now().strftime("%H:%M:%S")
    method = payload.get("method") if payload.get("method") in ("face", "manual") else "face"

    db = get_db()
    student = db.execute("SELECT * FROM students WHERE id = ?", (student_id,)).fetchone()
    if student is None:
        return jsonify({"error": "Student not found"}), 404
    existing = db.execute(
        "SELECT id, time FROM attendance WHERE student_id = ? AND day = ?", (student_id, day)
    ).fetchone()
    if existing:
        return jsonify(
            {
                "already_marked": True,
                "id": existing["id"],
                "student_id": student_id,
                "name": student["name"],
                "student_no": student["student_no"],
                "day": day,
                "time": existing["time"],
            }
        )
    cur = db.execute(
        "INSERT INTO attendance (student_id, day, time, method) VALUES (?, ?, ?, ?)",
        (student_id, day, time_str, method),
    )
    db.commit()
    return (
        jsonify(
            {
                "already_marked": False,
                "id": cur.lastrowid,
                "student_id": student_id,
                "name": student["name"],
                "student_no": student["student_no"],
                "day": day,
                "time": time_str,
            }
        ),
        201,
    )


@app.route("/api/attendance/<int:record_id>", methods=["DELETE"])
def delete_attendance(record_id):
    db = get_db()
    cur = db.execute("DELETE FROM attendance WHERE id = ?", (record_id,))
    db.commit()
    if cur.rowcount == 0:
        return jsonify({"error": "Record not found"}), 404
    return jsonify({"ok": True})


# ---------------------------------------------------------------------- export
def build_report(start, end):
    """Collect everything the exporters need for the given inclusive date range."""
    db = get_db()
    students = db.execute(
        "SELECT id, student_no, name, grade FROM students ORDER BY name COLLATE NOCASE"
    ).fetchall()
    records = db.execute(
        "SELECT a.student_id, a.day, a.time, a.method FROM attendance a "
        "WHERE a.day BETWEEN ? AND ? ORDER BY a.day, a.time",
        (start, end),
    ).fetchall()
    days = sorted({r["day"] for r in records})
    by_student = {}
    for r in records:
        by_student.setdefault(r["student_id"], {})[r["day"]] = r["time"]
    return {
        "start": start,
        "end": end,
        "students": [dict(s) for s in students],
        "records": [dict(r) for r in records],
        "days": days,
        "by_student": by_student,
        "generated": datetime.now().strftime("%Y-%m-%d %H:%M"),
    }


def export_filename(report, ext):
    return f"bus-attendance_{report['start']}_to_{report['end']}.{ext}"


@app.route("/api/export/excel")
def export_excel():
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter

    start, end = range_from_args()
    if start is None:
        return jsonify({"error": "Invalid date range"}), 400
    report = build_report(start, end)
    days = report["days"]
    n_days = len(days)

    wb = Workbook()
    head_font = Font(bold=True, color="FFFFFF")
    head_fill = PatternFill("solid", fgColor="1F4E78")
    present_fill = PatternFill("solid", fgColor="C6EFCE")
    absent_fill = PatternFill("solid", fgColor="FFC7CE")
    center = Alignment(horizontal="center")

    def style_header(ws, row=1):
        for cell in ws[row]:
            cell.font = head_font
            cell.fill = head_fill
            cell.alignment = center

    # Sheet 1: Summary
    ws = wb.active
    ws.title = "Summary"
    ws.append([f"Bus Attendance Summary  ({start} to {end})"])
    ws["A1"].font = Font(bold=True, size=14)
    ws.append([f"School days with records: {n_days}    Students: {len(report['students'])}    Generated: {report['generated']}"])
    ws.append([])
    ws.append(["No", "Student ID", "Name", "Class", "Days Present", "Days Absent", "Attendance %"])
    style_header(ws, 4)
    for i, s in enumerate(report["students"], 1):
        present = len(report["by_student"].get(s["id"], {}))
        pct = round(100 * present / n_days, 1) if n_days else 0
        ws.append([i, s["student_no"], s["name"], s["grade"], present, n_days - present, pct])
    for col, width in zip("ABCDEFG", (6, 14, 30, 12, 14, 14, 14)):
        ws.column_dimensions[col].width = width
    ws.freeze_panes = "A5"

    # Sheet 2: Daily matrix
    ws2 = wb.create_sheet("Daily")
    header = ["Student ID", "Name", "Class"] + days + ["Total"]
    ws2.append(header)
    style_header(ws2)
    for s in report["students"]:
        marks = report["by_student"].get(s["id"], {})
        row = [s["student_no"], s["name"], s["grade"]] + ["P" if d in marks else "A" for d in days] + [len(marks)]
        ws2.append(row)
        r = ws2.max_row
        for j, d in enumerate(days, start=4):
            cell = ws2.cell(row=r, column=j)
            cell.alignment = center
            cell.fill = present_fill if d in marks else absent_fill
    ws2.column_dimensions["A"].width = 14
    ws2.column_dimensions["B"].width = 30
    ws2.column_dimensions["C"].width = 12
    for j in range(4, 4 + n_days):
        ws2.column_dimensions[get_column_letter(j)].width = 11
    ws2.freeze_panes = "D2"

    # Sheet 3: Log
    ws3 = wb.create_sheet("Log")
    ws3.append(["Date", "Time", "Student ID", "Name", "Class", "Method"])
    style_header(ws3)
    lookup = {s["id"]: s for s in report["students"]}
    for r in report["records"]:
        s = lookup.get(r["student_id"], {})
        ws3.append([r["day"], r["time"], s.get("student_no", ""), s.get("name", ""), s.get("grade", ""), r["method"]])
    for col, width in zip("ABCDEF", (12, 10, 14, 30, 12, 10)):
        ws3.column_dimensions[col].width = width
    ws3.freeze_panes = "A2"

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return send_file(
        buf,
        as_attachment=True,
        download_name=export_filename(report, "xlsx"),
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )


@app.route("/api/export/pdf")
def export_pdf():
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    start, end = range_from_args()
    if start is None:
        return jsonify({"error": "Invalid date range"}), 400
    report = build_report(start, end)
    days = report["days"]
    n_days = len(days)

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=landscape(A4),
        leftMargin=12 * mm,
        rightMargin=12 * mm,
        topMargin=12 * mm,
        bottomMargin=12 * mm,
        title="Bus Attendance Report",
    )
    styles = getSampleStyleSheet()
    story = [
        Paragraph("Bus Attendance Report", styles["Title"]),
        Paragraph(
            f"Period: <b>{start}</b> to <b>{end}</b> &nbsp;&nbsp; School days with records: <b>{n_days}</b> "
            f"&nbsp;&nbsp; Students: <b>{len(report['students'])}</b> &nbsp;&nbsp; Generated: {report['generated']}",
            styles["Normal"],
        ),
        Spacer(1, 6 * mm),
    ]

    header_style = TableStyle(
        [
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1F4E78")),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("GRID", (0, 0), (-1, -1), 0.25, colors.grey),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F2F2F2")]),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ]
    )

    # Summary table
    data = [["No", "Student ID", "Name", "Class", "Present", "Absent", "%"]]
    for i, s in enumerate(report["students"], 1):
        present = len(report["by_student"].get(s["id"], {}))
        pct = f"{100 * present / n_days:.0f}%" if n_days else "-"
        data.append([i, s["student_no"], s["name"], s["grade"], present, n_days - present, pct])
    table = Table(data, repeatRows=1, colWidths=[12 * mm, 30 * mm, 90 * mm, 30 * mm, 22 * mm, 22 * mm, 18 * mm])
    table.setStyle(header_style)
    table.setStyle(TableStyle([("FONTSIZE", (0, 0), (-1, -1), 8), ("ALIGN", (4, 1), (-1, -1), "CENTER")]))
    story.append(Paragraph("Summary (the full scan log is included in the Excel export)", styles["Heading2"]))
    story.append(table)

    # Daily matrix (fits comfortably up to a month of school days)
    if 0 < n_days <= 31:
        story.append(PageBreak())
        story.append(Paragraph("Daily attendance (P = present, blank = absent)", styles["Heading2"]))
        day_labels = [d[5:] for d in days]  # MM-DD
        mdata = [["Student ID", "Name"] + day_labels + ["Tot"]]
        for s in report["students"]:
            marks = report["by_student"].get(s["id"], {})
            mdata.append([s["student_no"], s["name"]] + ["P" if d in marks else "" for d in days] + [len(marks)])
        avail = landscape(A4)[0] - 24 * mm - 25 * mm - 60 * mm - 10 * mm
        day_w = min(12 * mm, avail / n_days)
        mtable = Table(mdata, repeatRows=1, colWidths=[25 * mm, 60 * mm] + [day_w] * n_days + [10 * mm])
        mtable.setStyle(header_style)
        mtable.setStyle(
            TableStyle(
                [
                    ("FONTSIZE", (0, 0), (-1, -1), 6),
                    ("ALIGN", (2, 0), (-1, -1), "CENTER"),
                    ("TEXTCOLOR", (2, 1), (-2, -1), colors.HexColor("#0B6623")),
                ]
            )
        )
        story.append(mtable)

    doc.build(story)
    buf.seek(0)
    return send_file(buf, as_attachment=True, download_name=export_filename(report, "pdf"), mimetype="application/pdf")


@app.after_request
def add_headers(resp):
    if request.path.startswith("/static/models/") or request.path.startswith("/static/vendor/"):
        resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    elif request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)), debug=True)
