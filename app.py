import io
import json
import os
import sqlite3
import time
from datetime import datetime
from typing import Any

import requests
from flask import Flask, jsonify, request, send_file, session


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "invoice_history.db")
SECRET_KEY = os.environ.get("FLASK_SECRET_KEY", "invoice-demo-secret-key")
DEMO_USERNAME = os.environ.get("APP_USERNAME", "financeadmin")
DEMO_PASSWORD = os.environ.get("APP_PASSWORD", "Finance@123")

app = Flask(__name__, static_folder=BASE_DIR, static_url_path="")
app.secret_key = SECRET_KEY


FIELD_MAPPINGS = {
    "invoiceNumber": ["InvoiceId", "InvoiceNumber"],
    "vendorName": ["VendorName", "VendorAddressRecipient"],
    "invoiceDate": ["InvoiceDate"],
    "taxAmount": ["TotalTax", "Tax"],
    "totalAmount": ["AmountDue", "InvoiceTotal"],
}


def get_db_connection() -> sqlite3.Connection:
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def init_db() -> None:
    connection = get_db_connection()
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS invoices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_name TEXT NOT NULL,
            source_type TEXT,
            source_value TEXT,
            status TEXT,
            duration_ms INTEGER,
            invoice_number TEXT,
            invoice_number_confidence REAL,
            vendor_name TEXT,
            vendor_name_confidence REAL,
            invoice_date TEXT,
            invoice_date_confidence REAL,
            tax_amount TEXT,
            tax_amount_confidence REAL,
            total_amount TEXT,
            total_amount_confidence REAL,
            raw_content TEXT,
            created_at TEXT,
            created_by TEXT
        )
        """
    )
    connection.commit()
    connection.close()


init_db()


def require_auth() -> bool:
    return bool(session.get("user"))


def json_error(message: str, status_code: int = 400):
    return jsonify({"error": message}), status_code


def normalize_field(field: dict[str, Any] | None) -> dict[str, Any]:
    if not field:
        return {"value": "--", "confidence": 0}

    if isinstance(field.get("valueString"), str) and field["valueString"].strip():
        value = field["valueString"].strip()
    elif isinstance(field.get("valueDate"), str) and field["valueDate"].strip():
        value = field["valueDate"].strip()
    elif isinstance(field.get("valueNumber"), (int, float)):
        value = str(field["valueNumber"])
    elif isinstance(field.get("valueCurrency"), dict) and isinstance(field["valueCurrency"].get("amount"), (int, float)):
        currency = field["valueCurrency"].get("currencyCode") or ""
        value = f"{currency + ' ' if currency else ''}{field['valueCurrency']['amount']:.2f}"
    elif field.get("content"):
        value = str(field["content"]).strip()
    else:
        value = "--"

    confidence = field.get("confidence") if isinstance(field.get("confidence"), (int, float)) else 0
    return {"value": value, "confidence": confidence}


def get_field(fields: dict[str, Any], key: str) -> dict[str, Any]:
    for candidate in FIELD_MAPPINGS[key]:
        if candidate in fields:
            return normalize_field(fields[candidate])
    return {"value": "--", "confidence": 0}


def evaluate_status(extracted: dict[str, Any]) -> str:
    confidences = [extracted[field]["confidence"] for field in extracted]
    avg_confidence = sum(confidences) / len(confidences)
    has_all_fields = all(extracted[field]["value"] != "--" for field in extracted)
    return "Validated" if avg_confidence >= 0.92 and has_all_fields else "Needs review"


def fallback_invoice(name: str, source_type: str, source_value: str, error_message: str, duration_ms: int) -> dict[str, Any]:
    extracted = {
        "invoiceNumber": {"value": "--", "confidence": 0},
        "vendorName": {"value": "--", "confidence": 0},
        "invoiceDate": {"value": "--", "confidence": 0},
        "taxAmount": {"value": "--", "confidence": 0},
        "totalAmount": {"value": "--", "confidence": 0},
    }
    return {
        "name": name,
        "source_type": source_type,
        "source_value": source_value,
        "status": "Failed",
        "durationMs": duration_ms,
        "rawContent": "",
        "error": error_message,
        "extracted": extracted,
    }


def analyze_with_azure(
    *,
    endpoint: str,
    api_key: str,
    model_id: str,
    api_version: str,
    source_type: str,
    source_value: str | None = None,
    file_bytes: bytes | None = None,
    content_type: str | None = None,
    file_name: str,
) -> dict[str, Any]:
    start_time = time.perf_counter()
    headers = {"Ocp-Apim-Subscription-Key": api_key}
    analyze_url = f"{endpoint.rstrip('/')}/documentintelligence/documentModels/{model_id}:analyze?api-version={api_version}"

    try:
        if source_type == "url":
            headers["Content-Type"] = "application/json"
            response = requests.post(
                analyze_url,
                headers=headers,
                json={"urlSource": source_value},
                timeout=60,
            )
        else:
            headers["Content-Type"] = content_type or "application/octet-stream"
            response = requests.post(
                analyze_url,
                headers=headers,
                data=file_bytes or b"",
                timeout=60,
            )

        response.raise_for_status()
        operation_location = response.headers.get("operation-location")
        if not operation_location:
            raise ValueError("Azure did not return an operation location.")

        while True:
            poll_response = requests.get(
                operation_location,
                headers={"Ocp-Apim-Subscription-Key": api_key},
                timeout=60,
            )
            poll_response.raise_for_status()
            poll_data = poll_response.json()
            status = poll_data.get("status", "").lower()

            if status == "succeeded":
                document = (poll_data.get("analyzeResult", {}).get("documents") or [{}])[0]
                fields = document.get("fields", {})
                extracted = {
                    "invoiceNumber": get_field(fields, "invoiceNumber"),
                    "vendorName": get_field(fields, "vendorName"),
                    "invoiceDate": get_field(fields, "invoiceDate"),
                    "taxAmount": get_field(fields, "taxAmount"),
                    "totalAmount": get_field(fields, "totalAmount"),
                }

                duration_ms = round((time.perf_counter() - start_time) * 1000)
                return {
                    "name": file_name,
                    "source_type": source_type,
                    "source_value": source_value or file_name,
                    "status": evaluate_status(extracted),
                    "durationMs": duration_ms,
                    "rawContent": poll_data.get("analyzeResult", {}).get("content", ""),
                    "extracted": extracted,
                }

            if status == "failed":
                raise ValueError("Azure analysis failed for this invoice.")

            time.sleep(1.2)

    except Exception as exc:
        duration_ms = round((time.perf_counter() - start_time) * 1000)
        return fallback_invoice(file_name, source_type, source_value or file_name, str(exc), duration_ms)


def demo_invoice_result(index: int, file_name: str, source_type: str, source_value: str) -> dict[str, Any]:
    demo_rows = [
        {
            "invoiceNumber": {"value": "CE-2026-1048", "confidence": 0.99},
            "vendorName": {"value": "Contoso Electric Ltd.", "confidence": 0.98},
            "invoiceDate": {"value": "2026-04-03", "confidence": 0.97},
            "taxAmount": {"value": "USD 482.00", "confidence": 0.96},
            "totalAmount": {"value": "USD 6507.00", "confidence": 0.98},
            "status": "Validated",
            "durationMs": 2200,
        },
        {
            "invoiceNumber": {"value": "INV-8821", "confidence": 0.95},
            "vendorName": {"value": "Northwind Logistics", "confidence": 0.94},
            "invoiceDate": {"value": "2026-04-10", "confidence": 0.92},
            "taxAmount": {"value": "USD 96.35", "confidence": 0.90},
            "totalAmount": {"value": "USD 1301.35", "confidence": 0.94},
            "status": "Validated",
            "durationMs": 2480,
        },
        {
            "invoiceNumber": {"value": "FM-77-2026", "confidence": 0.88},
            "vendorName": {"value": "Fabrikam Medical Supplies", "confidence": 0.91},
            "invoiceDate": {"value": "2026-04-21", "confidence": 0.87},
            "taxAmount": {"value": "USD 141.00", "confidence": 0.83},
            "totalAmount": {"value": "USD 2491.00", "confidence": 0.89},
            "status": "Needs review",
            "durationMs": 2810,
        },
    ]
    row = demo_rows[index % len(demo_rows)]
    return {
        "name": file_name,
        "source_type": source_type,
        "source_value": source_value,
        "status": row["status"],
        "durationMs": row["durationMs"],
        "rawContent": "Demo mode invoice analysis result.",
        "extracted": {
            "invoiceNumber": row["invoiceNumber"],
            "vendorName": row["vendorName"],
            "invoiceDate": row["invoiceDate"],
            "taxAmount": row["taxAmount"],
            "totalAmount": row["totalAmount"],
        },
    }


def save_invoice(record: dict[str, Any], created_by: str) -> int:
    connection = get_db_connection()
    cursor = connection.execute(
        """
        INSERT INTO invoices (
            file_name, source_type, source_value, status, duration_ms,
            invoice_number, invoice_number_confidence,
            vendor_name, vendor_name_confidence,
            invoice_date, invoice_date_confidence,
            tax_amount, tax_amount_confidence,
            total_amount, total_amount_confidence,
            raw_content, created_at, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            record["name"],
            record.get("source_type"),
            record.get("source_value"),
            record.get("status"),
            record.get("durationMs"),
            record["extracted"]["invoiceNumber"]["value"],
            record["extracted"]["invoiceNumber"]["confidence"],
            record["extracted"]["vendorName"]["value"],
            record["extracted"]["vendorName"]["confidence"],
            record["extracted"]["invoiceDate"]["value"],
            record["extracted"]["invoiceDate"]["confidence"],
            record["extracted"]["taxAmount"]["value"],
            record["extracted"]["taxAmount"]["confidence"],
            record["extracted"]["totalAmount"]["value"],
            record["extracted"]["totalAmount"]["confidence"],
            record.get("rawContent", ""),
            datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            created_by,
        ),
    )
    connection.commit()
    invoice_id = cursor.lastrowid
    connection.close()
    return int(invoice_id)


def fetch_invoices_by_ids(invoice_ids: list[int]) -> list[sqlite3.Row]:
    if not invoice_ids:
        return []
    connection = get_db_connection()
    placeholders = ",".join("?" for _ in invoice_ids)
    rows = connection.execute(
        f"SELECT * FROM invoices WHERE id IN ({placeholders}) ORDER BY created_at DESC",
        invoice_ids,
    ).fetchall()
    connection.close()
    return rows


def wrap_line(text: str, width: int, font_name: str, font_size: int) -> list[str]:
    from reportlab.pdfbase.pdfmetrics import stringWidth

    if not text:
        return [""]
    words = text.split()
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = word if not current else f"{current} {word}"
        if stringWidth(candidate, font_name, font_size) <= width:
            current = candidate
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines or [text]


@app.route("/")
def index():
    return app.send_static_file("index.html")


@app.post("/api/login")
def login():
    payload = request.get_json(silent=True) or {}
    username = (payload.get("username") or "").strip()
    password = payload.get("password") or ""

    if username != DEMO_USERNAME or password != DEMO_PASSWORD:
        return json_error("Invalid username or password.", 401)

    session["user"] = username
    return jsonify({"user": username})


@app.get("/api/session")
def get_session():
    user = session.get("user")
    return jsonify({"authenticated": bool(user), "user": user})


@app.post("/api/logout")
def logout():
    session.clear()
    return jsonify({"success": True})


@app.post("/api/analyze")
def analyze():
    if not require_auth():
        return json_error("Authentication required.", 401)

    endpoint = (request.form.get("endpoint") or "").strip()
    api_key = (request.form.get("key") or "").strip()
    model_id = (request.form.get("modelId") or "prebuilt-invoice").strip()
    api_version = (request.form.get("apiVersion") or "2024-11-30").strip()
    raw_urls = request.form.get("urls") or "[]"

    try:
        urls = json.loads(raw_urls)
    except json.JSONDecodeError:
        urls = []

    files = request.files.getlist("files")
    if not files and not urls:
        return json_error("Please upload at least one invoice file or URL.")

    use_demo_mode = not endpoint or not api_key
    results: list[dict[str, Any]] = []

    for index, uploaded_file in enumerate(files):
        file_name = uploaded_file.filename or f"invoice-{index + 1}"
        if use_demo_mode:
            result = demo_invoice_result(index, file_name, "file", file_name)
        else:
            result = analyze_with_azure(
                endpoint=endpoint,
                api_key=api_key,
                model_id=model_id,
                api_version=api_version,
                source_type="file",
                file_bytes=uploaded_file.read(),
                content_type=uploaded_file.mimetype,
                file_name=file_name,
            )
        result["id"] = save_invoice(result, session["user"])
        results.append(result)

    for index, url in enumerate(urls, start=len(files)):
        file_name = os.path.basename(url) or f"url-invoice-{index + 1}"
        if use_demo_mode:
            result = demo_invoice_result(index, file_name, "url", url)
        else:
            result = analyze_with_azure(
                endpoint=endpoint,
                api_key=api_key,
                model_id=model_id,
                api_version=api_version,
                source_type="url",
                source_value=url,
                file_name=file_name,
            )
        result["id"] = save_invoice(result, session["user"])
        results.append(result)

    return jsonify({"invoices": results})


@app.get("/api/history")
def history():
    if not require_auth():
        return json_error("Authentication required.", 401)

    connection = get_db_connection()
    rows = connection.execute(
        """
        SELECT id, file_name, status, duration_ms, invoice_number, invoice_number_confidence,
               vendor_name, vendor_name_confidence, invoice_date, invoice_date_confidence,
               tax_amount, tax_amount_confidence, total_amount, total_amount_confidence, created_at
        FROM invoices
        ORDER BY created_at DESC
        LIMIT 50
        """
    ).fetchall()
    connection.close()
    return jsonify({"history": [dict(row) for row in rows]})


@app.post("/api/report")
def report():
    if not require_auth():
        return json_error("Authentication required.", 401)

    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.pdfgen import canvas
    except ModuleNotFoundError:
        return json_error("PDF export requires the reportlab package. Install dependencies from requirements.txt.", 500)

    payload = request.get_json(silent=True) or {}
    invoice_ids = payload.get("invoice_ids") or []
    valid_ids = [int(item) for item in invoice_ids if str(item).isdigit()]
    rows = fetch_invoices_by_ids(valid_ids)
    if not rows:
        return json_error("No matching invoice records found for PDF export.", 404)

    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=A4)
    width, height = A4
    y = height - 50

    pdf.setTitle("Invoice Intelligence Report")
    pdf.setFont("Helvetica-Bold", 18)
    pdf.drawString(42, y, "Invoice Intelligence Report")
    y -= 22
    pdf.setFont("Helvetica", 10)
    pdf.drawString(42, y, f"Generated on {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    y -= 30

    for row in rows:
        pdf.setFont("Helvetica-Bold", 12)
        pdf.drawString(42, y, row["file_name"])
        y -= 16
        pdf.setFont("Helvetica", 10)

        lines = [
            f"Status: {row['status']}",
            f"Vendor: {row['vendor_name'] or '--'}",
            f"Invoice Number: {row['invoice_number'] or '--'}",
            f"Invoice Date: {row['invoice_date'] or '--'}",
            f"Tax Amount: {row['tax_amount'] or '--'}",
            f"Total Amount: {row['total_amount'] or '--'}",
            f"Processing Time: {row['duration_ms'] or 0} ms",
            f"Stored At: {row['created_at'] or '--'}",
        ]

        for line in lines:
            for wrapped in wrap_line(line, int(width - 84), "Helvetica", 10):
                pdf.drawString(42, y, wrapped)
                y -= 14
                if y < 60:
                    pdf.showPage()
                    y = height - 50
                    pdf.setFont("Helvetica", 10)

        y -= 10
        if y < 70:
            pdf.showPage()
            y = height - 50

    pdf.save()
    buffer.seek(0)
    return send_file(
        buffer,
        mimetype="application/pdf",
        as_attachment=True,
        download_name="invoice-report.pdf",
    )


if __name__ == "__main__":
    app.run(debug=True)
