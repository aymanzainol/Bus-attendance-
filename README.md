# 🚌 Bus Attendance

Mobile-friendly web app to take school-bus attendance for ~200 students with
face recognition, and export the records as **Excel** or **PDF**.

Two tabs only:

| Tab | What it does |
| --- | --- |
| **Students** | Add a student (name, ID, class, bus number) and register their face with the phone camera or an uploaded photo. See who is present/absent today, attendance history per student, filter by bus, and export a date range (all buses or one bus) to Excel / PDF. |
| **Scan** | Live camera. Every recognised face is marked present automatically (once per day). Shows today's present list with undo, plus a manual-mark search for students the camera cannot see. |

## How it works

* Face detection and recognition run **in the browser** with
  [face-api.js](https://github.com/justadudewhohacks/face-api.js) (the same
  128-d face embedding + Euclidean-distance approach as
  [`face_recognition`](https://github.com/ageitgey/face_recognition), but
  without a native dlib build on the server). Models are served from
  `static/models` and cached by the browser.
* The Flask backend (`app.py`) stores students, their face descriptors and
  attendance in SQLite, and produces the exports with **openpyxl** and
  **reportlab**.
* Excel export has three sheets: `Summary` (present/absent/% per student),
  `Daily` (student × date matrix, P/A) and `Log` (every scan with time).
  The PDF contains the summary and the daily matrix.

## Run locally

```bash
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
python app.py            # http://localhost:8080
```

The camera only works on `https://` or `localhost`.

## Deploy on Railway

The repo ships with a `Dockerfile` and `railway.json`; Railway builds it
automatically. Attach a **volume** mounted at `/data` so the SQLite database
survives redeploys (`DATA_DIR` defaults to `/data` in the image).

## API (used by the frontend)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/students?date=YYYY-MM-DD` | All students with today's status |
| POST | `/api/students` | Create student (`name`, `student_no`, `grade`, `bus_no`, `photo`, `descriptors`) |
| GET | `/api/buses` | Distinct bus numbers with student counts |
| PUT/DELETE | `/api/students/<id>` | Update / delete |
| GET | `/api/students/<id>/history` | Attendance history |
| GET | `/api/attendance?date=` | Records for a day |
| POST | `/api/attendance` | Mark present (`student_id`, `day`, `time`, `method`) |
| DELETE | `/api/attendance/<id>` | Undo a record |
| GET | `/api/export/excel?from=&to=&bus=` | Excel workbook (`bus` optional) |
| GET | `/api/export/pdf?from=&to=&bus=` | PDF report (`bus` optional) |
