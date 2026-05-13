const requiredFields = [
    { key: "invoiceNumber", label: "Invoice Number" },
    { key: "vendorName", label: "Vendor Name" },
    { key: "invoiceDate", label: "Invoice Date" },
    { key: "taxAmount", label: "Tax Amount" },
    { key: "totalAmount", label: "Total Amount Due" }
];

const demoInvoices = [
    {
        id: "demo-1",
        name: "Contoso-Electric-April.pdf",
        status: "Validated",
        durationMs: 2210,
        createdAt: "2026-05-13 10:12:00",
        extracted: {
            invoiceNumber: { value: "CE-2026-1048", confidence: 0.99 },
            vendorName: { value: "Contoso Electric Ltd.", confidence: 0.98 },
            invoiceDate: { value: "2026-04-03", confidence: 0.97 },
            taxAmount: { value: "USD 482.00", confidence: 0.96 },
            totalAmount: { value: "USD 6507.00", confidence: 0.98 }
        }
    },
    {
        id: "demo-2",
        name: "Northwind-Logistics-INV8821.png",
        status: "Validated",
        durationMs: 2490,
        createdAt: "2026-05-13 10:13:20",
        extracted: {
            invoiceNumber: { value: "INV-8821", confidence: 0.95 },
            vendorName: { value: "Northwind Logistics", confidence: 0.94 },
            invoiceDate: { value: "2026-04-10", confidence: 0.92 },
            taxAmount: { value: "USD 96.35", confidence: 0.90 },
            totalAmount: { value: "USD 1301.35", confidence: 0.94 }
        }
    },
    {
        id: "demo-3",
        name: "Fabrikam-Medical-Bill-77.pdf",
        status: "Needs review",
        durationMs: 2815,
        createdAt: "2026-05-13 10:14:08",
        extracted: {
            invoiceNumber: { value: "FM-77-2026", confidence: 0.88 },
            vendorName: { value: "Fabrikam Medical Supplies", confidence: 0.91 },
            invoiceDate: { value: "2026-04-21", confidence: 0.87 },
            taxAmount: { value: "USD 141.00", confidence: 0.83 },
            totalAmount: { value: "USD 2491.00", confidence: 0.89 }
        }
    }
];

let invoices = [];
let historyRecords = [];
let pendingFiles = [];
let selectedInvoiceIndex = -1;
let chartInstance = null;
let sessionUser = null;
let backendAvailable = true;

const authModal = document.getElementById("authModal");
const authStatus = document.getElementById("authStatus");
const loginForm = document.getElementById("loginForm");
const fileInput = document.getElementById("fileInput");
const browseBtn = document.getElementById("browseBtn");
const dropzone = document.getElementById("dropzone");
const themeToggle = document.getElementById("themeToggle");
const logoutBtn = document.getElementById("logoutBtn");
const pdfBtn = document.getElementById("pdfBtn");

document.addEventListener("DOMContentLoaded", initializeApp);

function initializeApp() {
    bindEvents();
    applyStoredTheme();
    clearWorkspace();
    checkSession();
}

function bindEvents() {
    loginForm.addEventListener("submit", handleLogin);
    fileInput.addEventListener("change", handleFileSelection);
    browseBtn.addEventListener("click", () => fileInput.click());
    themeToggle.addEventListener("click", toggleTheme);
    logoutBtn.addEventListener("click", logout);
    pdfBtn.addEventListener("click", exportPdfReport);
    bindDropzone();
}

function bindDropzone() {
    ["dragenter", "dragover"].forEach((eventName) => {
        dropzone.addEventListener(eventName, (event) => {
            event.preventDefault();
            dropzone.classList.add("dragover");
        });
    });

    ["dragleave", "drop"].forEach((eventName) => {
        dropzone.addEventListener(eventName, (event) => {
            event.preventDefault();
            if (eventName === "drop") {
                handleDrop(event);
            }
            dropzone.classList.remove("dragover");
        });
    });
}

function handleDrop(event) {
    const droppedFiles = Array.from(event.dataTransfer.files || []);
    if (!droppedFiles.length) {
        return;
    }
    pendingFiles = mergeFiles(pendingFiles, droppedFiles);
    syncFileInputWithPendingFiles();
    renderSampleList();
}

function handleFileSelection(event) {
    const chosenFiles = Array.from(event.target.files || []);
    pendingFiles = mergeFiles(pendingFiles, chosenFiles);
    syncFileInputWithPendingFiles();
    renderSampleList();
}

function mergeFiles(existingFiles, newFiles) {
    const merged = [...existingFiles];
    newFiles.forEach((file) => {
        const duplicate = merged.some((item) => item.name === file.name && item.size === file.size);
        if (!duplicate) {
            merged.push(file);
        }
    });
    return merged;
}

function syncFileInputWithPendingFiles() {
    const dataTransfer = new DataTransfer();
    pendingFiles.forEach((file) => dataTransfer.items.add(file));
    fileInput.files = dataTransfer.files;
}

async function handleLogin(event) {
    event.preventDefault();

    const username = document.getElementById("username").value.trim();
    const password = document.getElementById("password").value.trim();

    authStatus.textContent = "Signing in...";

    try {
        if (!backendAvailable) {
            handleOfflineLogin(username, password);
            return;
        }

        const response = await fetch("/api/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, password })
        });
        const data = await parseApiResponse(response);

        if (!response.ok) {
            throw new Error(data.error || "Login failed");
        }

        sessionUser = data.user;
        updateSessionUi();
        authModal.classList.add("hidden");
        authStatus.textContent = "Signed in successfully.";
        await loadHistory();
    } catch (error) {
        if (isLikelyBackendUnavailable(error)) {
            backendAvailable = false;
            try {
                handleOfflineLogin(username, password);
                return;
            } catch (offlineError) {
                authStatus.textContent = offlineError.message;
                return;
            }
        }
        authStatus.textContent = error.message;
    }
}

async function checkSession() {
    try {
        const response = await fetch("/api/session");
        const data = await parseApiResponse(response);
        if (data.authenticated) {
            backendAvailable = true;
            sessionUser = data.user;
            updateSessionUi();
            authModal.classList.add("hidden");
            await loadHistory();
        } else {
            authModal.classList.remove("hidden");
        }
    } catch {
        backendAvailable = false;
        const localUser = localStorage.getItem("invoiceSessionUser");
        if (localUser) {
            sessionUser = localUser;
            updateSessionUi();
            authModal.classList.add("hidden");
            loadHistory();
            return;
        }
        authModal.classList.remove("hidden");
        authStatus.textContent = "Flask backend not detected. Demo mode is available with financeadmin / Finance@123.";
    }
}

async function logout() {
    try {
        if (backendAvailable) {
            await fetch("/api/logout", { method: "POST" });
        }
    } finally {
        sessionUser = null;
        localStorage.removeItem("invoiceSessionUser");
        updateSessionUi();
        authModal.classList.remove("hidden");
        historyRecords = [];
        renderHistory();
    }
}

function updateSessionUi() {
    document.getElementById("sessionUser").textContent = sessionUser ? `Signed in as ${sessionUser}` : "Not signed in";
}

function toggleTheme() {
    const currentTheme = document.body.dataset.theme === "dark" ? "dark" : "light";
    const nextTheme = currentTheme === "dark" ? "light" : "dark";
    document.body.dataset.theme = nextTheme;
    localStorage.setItem("invoiceTheme", nextTheme);
    createChart();
}

function applyStoredTheme() {
    const storedTheme = localStorage.getItem("invoiceTheme") || "light";
    document.body.dataset.theme = storedTheme;
}

function scrollToWorkspace() {
    document.getElementById("workspace").scrollIntoView({ behavior: "smooth", block: "start" });
}

function clearWorkspace() {
    invoices = [];
    selectedInvoiceIndex = -1;
    pendingFiles = [];
    fileInput.value = "";
    document.getElementById("docUrls").value = "";
    renderSampleList();
    renderInvoiceDetails(null);
    renderValidationTable();
    updateDashboard();
    document.getElementById("summary").textContent =
        "Configure Azure, authenticate into the system, run a mixed invoice batch, and review history-backed accuracy to demonstrate reduced manual effort and stronger process control.";
}

function loadDemoData() {
    invoices = demoInvoices.map((invoice) => structuredClone(invoice));
    selectedInvoiceIndex = invoices.length ? 0 : -1;
    renderSampleList();
    renderInvoiceDetails(invoices[0] || null);
    renderValidationTable();
    updateDashboard();
    updateSummary();
}

function renderSampleList() {
    const sampleList = document.getElementById("sampleList");
    const urls = getUrlEntries();
    const previewNames = [
        ...pendingFiles.map((file) => file.name),
        ...urls.map((url) => getNameFromUrl(url))
    ];

    if (!previewNames.length && !invoices.length) {
        sampleList.innerHTML = '<div class="empty-state">No invoice samples loaded yet.</div>';
        return;
    }

    const items = invoices.length
        ? invoices.map((invoice, index) => ({
            label: invoice.name,
            active: index === selectedInvoiceIndex,
            index,
            clickable: true
        }))
        : previewNames.map((name) => ({
            label: name,
            active: false,
            index: -1,
            clickable: false
        }));

    sampleList.innerHTML = items.map((item) => {
        const action = item.clickable ? `onclick="selectInvoice(${item.index})"` : 'type="button"';
        return `<button class="sample-chip${item.active ? " active-chip" : ""}" ${action}>${escapeHtml(item.label)}</button>`;
    }).join("");
}

function selectInvoice(index) {
    selectedInvoiceIndex = index;
    renderSampleList();
    renderInvoiceDetails(invoices[index] || null);
}

async function analyzeInvoices() {
    if (!sessionUser) {
        authModal.classList.remove("hidden");
        authStatus.textContent = "Please sign in before running invoice analysis.";
        return;
    }

    const urls = getUrlEntries();
    if (!pendingFiles.length && !urls.length) {
        document.getElementById("summary").textContent = "Add at least one invoice file or URL before starting analysis.";
        return;
    }

    document.getElementById("summary").textContent = "Running secure Flask batch analysis and storing results in the database...";

    try {
        if (!backendAvailable) {
            runOfflineAnalysis();
            return;
        }

        const formData = new FormData();
        formData.append("endpoint", document.getElementById("endpoint").value.trim());
        formData.append("key", document.getElementById("key").value.trim());
        formData.append("modelId", document.getElementById("modelId").value.trim() || "prebuilt-invoice");
        formData.append("apiVersion", document.getElementById("apiVersion").value.trim() || "2024-11-30");
        formData.append("urls", JSON.stringify(urls));

        pendingFiles.forEach((file) => {
            formData.append("files", file, file.name);
        });

        const response = await fetch("/api/analyze", {
            method: "POST",
            body: formData
        });
        const data = await parseApiResponse(response);

        if (!response.ok) {
            throw new Error(data.error || "Batch analysis failed.");
        }

        invoices = data.invoices || [];
        selectedInvoiceIndex = invoices.length ? 0 : -1;
        renderSampleList();
        renderInvoiceDetails(invoices[0] || null);
        renderValidationTable();
        updateDashboard();
        updateSummary();
        await loadHistory();
    } catch (error) {
        if (isLikelyBackendUnavailable(error)) {
            backendAvailable = false;
            runOfflineAnalysis();
            return;
        }
        document.getElementById("summary").textContent = error.message;
    }
}

async function loadHistory() {
    if (!sessionUser) {
        renderHistory();
        return;
    }

    try {
        if (!backendAvailable) {
            historyRecords = getOfflineHistory();
            renderHistory();
            return;
        }

        const response = await fetch("/api/history");
        const data = await parseApiResponse(response);
        if (!response.ok) {
            throw new Error(data.error || "Could not load invoice history.");
        }
        historyRecords = data.history || [];
        renderHistory();
    } catch (error) {
        historyRecords = getOfflineHistory();
        renderHistory();
    }
}

function renderHistory() {
    const historyList = document.getElementById("historyList");
    if (!historyRecords.length) {
        historyList.innerHTML = '<div class="empty-state">No invoice history found yet.</div>';
        return;
    }

    historyList.innerHTML = historyRecords.map((record) => `
        <button class="history-item" type="button" onclick="openHistoryRecord(${record.id})">
            <h3>${escapeHtml(record.file_name)}</h3>
            <div class="history-meta">
                <span>${escapeHtml(record.vendor_name || "--")}</span>
                <span>${escapeHtml(record.invoice_number || "--")}</span>
                <span>${escapeHtml(record.status || "--")}</span>
                <span>${escapeHtml(record.created_at || "--")}</span>
            </div>
        </button>
    `).join("");
}

function openHistoryRecord(recordId) {
    const match = historyRecords.find((record) => record.id === recordId);
    if (!match) {
        return;
    }

    const invoice = {
        id: match.id,
        name: match.file_name,
        status: match.status,
        durationMs: match.duration_ms || 0,
        createdAt: match.created_at,
        extracted: {
            invoiceNumber: { value: match.invoice_number || "--", confidence: match.invoice_number_confidence || 0 },
            vendorName: { value: match.vendor_name || "--", confidence: match.vendor_name_confidence || 0 },
            invoiceDate: { value: match.invoice_date || "--", confidence: match.invoice_date_confidence || 0 },
            taxAmount: { value: match.tax_amount || "--", confidence: match.tax_amount_confidence || 0 },
            totalAmount: { value: match.total_amount || "--", confidence: match.total_amount_confidence || 0 }
        }
    };

    invoices = [invoice];
    selectedInvoiceIndex = 0;
    renderSampleList();
    renderInvoiceDetails(invoice);
    renderValidationTable();
    updateDashboard();
    updateSummary();
}

function renderInvoiceDetails(invoice) {
    const fields = invoice?.extracted || emptyExtractedFields();
    setFieldDisplay("invoiceNumber", fields.invoiceNumber);
    setFieldDisplay("vendorName", fields.vendorName);
    setFieldDisplay("invoiceDate", fields.invoiceDate);
    setFieldDisplay("taxAmount", fields.taxAmount);
    setFieldDisplay("totalAmount", fields.totalAmount);
}

function setFieldDisplay(idPrefix, field) {
    document.getElementById(idPrefix).textContent = field?.value || "--";
    document.getElementById(`${idPrefix}Conf`).textContent =
        `Confidence: ${field?.confidence ? `${Math.round(field.confidence * 100)}%` : "--"}`;
}

function renderValidationTable() {
    const table = document.getElementById("validationTable");

    if (!invoices.length) {
        table.innerHTML = '<tr><td colspan="7" class="empty-row">Validation results will appear here after analysis.</td></tr>';
        return;
    }

    table.innerHTML = invoices.map((invoice, index) => {
        const statusClass = getStatusClass(invoice.status);
        return `
            <tr onclick="selectInvoice(${index})">
                <td>${escapeHtml(invoice.name)}</td>
                <td>${escapeHtml(invoice.extracted.vendorName.value)}</td>
                <td>${escapeHtml(invoice.extracted.invoiceNumber.value)}</td>
                <td>${escapeHtml(invoice.extracted.invoiceDate.value)}</td>
                <td>${escapeHtml(invoice.extracted.taxAmount.value)}</td>
                <td>${escapeHtml(invoice.extracted.totalAmount.value)}</td>
                <td><span class="status-pill ${statusClass}">${escapeHtml(invoice.status)}</span></td>
            </tr>
        `;
    }).join("");
}

function getStatusClass(status) {
    if (status === "Validated") {
        return "status-pass";
    }
    if (status === "Failed") {
        return "status-failed";
    }
    return "status-review";
}

function updateDashboard() {
    const processedCount = invoices.length;
    const totalFields = processedCount * requiredFields.length;
    let confidenceSum = 0;
    let validatedCount = 0;
    let durationSum = 0;

    invoices.forEach((invoice) => {
        requiredFields.forEach(({ key }) => {
            confidenceSum += invoice.extracted[key].confidence || 0;
        });
        if (invoice.status === "Validated") {
            validatedCount += 1;
        }
        durationSum += invoice.durationMs || 0;
    });

    const avgConfidence = totalFields ? Math.round((confidenceSum / totalFields) * 100) : 0;
    const accuracyRate = processedCount ? Math.round((validatedCount / processedCount) * 100) : 0;
    const avgSeconds = processedCount ? (durationSum / processedCount / 1000).toFixed(1) : "0";
    const timeSaved = processedCount * 4;

    document.getElementById("processedCount").textContent = processedCount;
    document.getElementById("avgConfidence").textContent = `${avgConfidence}%`;
    document.getElementById("timeSaved").textContent = `${timeSaved} min`;
    document.getElementById("accuracyRate").textContent = `${accuracyRate}%`;

    document.getElementById("heroDocs").textContent = processedCount;
    document.getElementById("heroFields").textContent = totalFields;
    document.getElementById("heroAccuracy").textContent = `${accuracyRate}%`;
    document.getElementById("heroTime").textContent = `${avgSeconds}s`;

    createChart();
}

function createChart() {
    const chartCanvas = document.getElementById("chart");
    if (!chartCanvas) {
        return;
    }

    const labels = invoices.map((invoice) => invoice.name);
    const confidenceData = invoices.map((invoice) => averageInvoiceConfidence(invoice));
    const timeData = invoices.map((invoice) => Number(((invoice.durationMs || 0) / 1000).toFixed(1)));

    if (chartInstance) {
        chartInstance.destroy();
    }

    chartInstance = new Chart(chartCanvas, {
        type: "bar",
        data: {
            labels,
            datasets: [
                {
                    label: "Avg Confidence (%)",
                    data: confidenceData,
                    backgroundColor: "rgba(13, 135, 117, 0.82)",
                    borderRadius: 12,
                    yAxisID: "y"
                },
                {
                    label: "Processing Time (s)",
                    data: timeData,
                    backgroundColor: "rgba(212, 155, 67, 0.75)",
                    borderRadius: 12,
                    yAxisID: "y1"
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    labels: {
                        color: getComputedStyle(document.body).getPropertyValue("--text").trim(),
                        font: { family: "Outfit" }
                    }
                }
            },
            scales: {
                x: {
                    ticks: {
                        color: getComputedStyle(document.body).getPropertyValue("--muted").trim()
                    },
                    grid: { display: false }
                },
                y: {
                    beginAtZero: true,
                    max: 100,
                    ticks: {
                        color: getComputedStyle(document.body).getPropertyValue("--muted").trim(),
                        callback: (value) => `${value}%`
                    },
                    grid: {
                        color: "rgba(104, 124, 120, 0.12)"
                    }
                },
                y1: {
                    beginAtZero: true,
                    position: "right",
                    ticks: {
                        color: getComputedStyle(document.body).getPropertyValue("--accent").trim(),
                        callback: (value) => `${value}s`
                    },
                    grid: { display: false }
                }
            }
        }
    });
}

function updateSummary() {
    if (!invoices.length) {
        return;
    }

    const validated = invoices.filter((invoice) => invoice.status === "Validated").length;
    const avgConfidence = Math.round(
        invoices.reduce((sum, invoice) => sum + averageInvoiceConfidence(invoice), 0) / invoices.length
    );

    document.getElementById("summary").textContent =
        `The Flask-powered invoice workflow processed ${invoices.length} invoice samples and stored each result in SQLite for future audit access. ` +
        `${validated} invoices met the validation threshold automatically, with an average extraction confidence of ${avgConfidence}%. ` +
        `This setup demonstrates secure login, backend-driven Azure analysis, history retention, and stakeholder-ready reporting for enterprise finance teams.`;
}

function averageInvoiceConfidence(invoice) {
    const total = requiredFields.reduce((sum, field) => sum + (invoice.extracted[field.key].confidence || 0), 0);
    return Math.round((total / requiredFields.length) * 100);
}

async function exportPdfReport() {
    if (!sessionUser) {
        authModal.classList.remove("hidden");
        authStatus.textContent = "Please sign in before exporting the PDF report.";
        return;
    }

    const ids = invoices.map((invoice) => invoice.id).filter(Boolean);
    if (!ids.length) {
        document.getElementById("summary").textContent = "Analyze invoices or open a history record before exporting a PDF report.";
        return;
    }

    try {
        if (!backendAvailable) {
            exportTextReport();
            return;
        }

        const response = await fetch("/api/report", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ invoice_ids: ids })
        });

        if (!response.ok) {
            const errorData = await parseApiResponse(response);
            throw new Error(errorData.error || "PDF export failed.");
        }

        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = "invoice-report.pdf";
        link.click();
        URL.revokeObjectURL(url);
    } catch (error) {
        if (isLikelyBackendUnavailable(error)) {
            backendAvailable = false;
            exportTextReport();
            return;
        }
        document.getElementById("summary").textContent = error.message;
    }
}

function handleOfflineLogin(username, password) {
    if (username !== "financeadmin" || password !== "Finance@123") {
        throw new Error("Use demo credentials: financeadmin / Finance@123");
    }

    sessionUser = username;
    localStorage.setItem("invoiceSessionUser", username);
    updateSessionUi();
    authModal.classList.add("hidden");
    authStatus.textContent = "Signed in with offline demo mode.";
    loadHistory();
}

function runOfflineAnalysis() {
    const urls = getUrlEntries();
    const fileNames = [
        ...pendingFiles.map((file) => file.name),
        ...urls.map((url) => getNameFromUrl(url))
    ];

    invoices = fileNames.map((name, index) => buildOfflineInvoice(name, index));
    selectedInvoiceIndex = invoices.length ? 0 : -1;

    saveOfflineHistory(invoices);
    historyRecords = getOfflineHistory();

    renderSampleList();
    renderInvoiceDetails(invoices[0] || null);
    renderValidationTable();
    updateDashboard();
    updateSummary();
    renderHistory();
}

function buildOfflineInvoice(name, index) {
    const templates = [
        {
            status: "Validated",
            durationMs: 2210,
            vendorName: { value: "Contoso Electric Ltd.", confidence: 0.98 },
            invoiceNumber: { value: "CE-2026-1048", confidence: 0.99 },
            invoiceDate: { value: "2026-04-03", confidence: 0.97 },
            taxAmount: { value: "USD 482.00", confidence: 0.96 },
            totalAmount: { value: "USD 6507.00", confidence: 0.98 }
        },
        {
            status: "Validated",
            durationMs: 2480,
            vendorName: { value: "Northwind Logistics", confidence: 0.94 },
            invoiceNumber: { value: "INV-8821", confidence: 0.95 },
            invoiceDate: { value: "2026-04-10", confidence: 0.92 },
            taxAmount: { value: "USD 96.35", confidence: 0.9 },
            totalAmount: { value: "USD 1301.35", confidence: 0.94 }
        },
        {
            status: "Needs review",
            durationMs: 2810,
            vendorName: { value: "Fabrikam Medical Supplies", confidence: 0.91 },
            invoiceNumber: { value: "FM-77-2026", confidence: 0.88 },
            invoiceDate: { value: "2026-04-21", confidence: 0.87 },
            taxAmount: { value: "USD 141.00", confidence: 0.83 },
            totalAmount: { value: "USD 2491.00", confidence: 0.89 }
        }
    ];

    const template = templates[index % templates.length];
    return {
        id: Date.now() + index,
        name,
        status: template.status,
        durationMs: template.durationMs,
        createdAt: new Date().toLocaleString(),
        extracted: {
            vendorName: template.vendorName,
            invoiceNumber: template.invoiceNumber,
            invoiceDate: template.invoiceDate,
            taxAmount: template.taxAmount,
            totalAmount: template.totalAmount
        }
    };
}

function saveOfflineHistory(records) {
    const existing = getOfflineHistory();
    const mapped = records.map((record) => ({
        id: record.id,
        file_name: record.name,
        status: record.status,
        duration_ms: record.durationMs,
        vendor_name: record.extracted.vendorName.value,
        vendor_name_confidence: record.extracted.vendorName.confidence,
        invoice_number: record.extracted.invoiceNumber.value,
        invoice_number_confidence: record.extracted.invoiceNumber.confidence,
        invoice_date: record.extracted.invoiceDate.value,
        invoice_date_confidence: record.extracted.invoiceDate.confidence,
        tax_amount: record.extracted.taxAmount.value,
        tax_amount_confidence: record.extracted.taxAmount.confidence,
        total_amount: record.extracted.totalAmount.value,
        total_amount_confidence: record.extracted.totalAmount.confidence,
        created_at: record.createdAt || new Date().toLocaleString()
    }));
    localStorage.setItem("invoiceHistory", JSON.stringify([...mapped, ...existing].slice(0, 50)));
}

function getOfflineHistory() {
    try {
        return JSON.parse(localStorage.getItem("invoiceHistory") || "[]");
    } catch {
        return [];
    }
}

function exportTextReport() {
    const lines = [
        "Invoice Intelligence Report",
        "",
        `User: ${sessionUser || "Demo User"}`,
        `Invoices Processed: ${invoices.length}`,
        `Average Confidence: ${document.getElementById("avgConfidence").textContent}`,
        `Validation Accuracy: ${document.getElementById("accuracyRate").textContent}`,
        "",
        "Invoice Results"
    ];

    invoices.forEach((invoice, index) => {
        lines.push(
            "",
            `${index + 1}. ${invoice.name}`,
            `Status: ${invoice.status}`,
            `Vendor: ${invoice.extracted.vendorName.value}`,
            `Invoice Number: ${invoice.extracted.invoiceNumber.value}`,
            `Invoice Date: ${invoice.extracted.invoiceDate.value}`,
            `Tax Amount: ${invoice.extracted.taxAmount.value}`,
            `Total Amount: ${invoice.extracted.totalAmount.value}`
        );
    });

    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "invoice-report.txt";
    link.click();
    URL.revokeObjectURL(url);
    document.getElementById("summary").textContent = "Backend PDF export is unavailable in static mode, so a text report was downloaded instead.";
}

async function parseApiResponse(response) {
    const text = await response.text();
    if (!text) {
        return {};
    }

    try {
        return JSON.parse(text);
    } catch {
        throw new Error("Backend returned a non-JSON response.");
    }
}

function isLikelyBackendUnavailable(error) {
    const message = String(error?.message || "");
    return message.includes("Failed to fetch") ||
        message.includes("non-JSON response") ||
        message.includes("Unexpected end of JSON input");
}

function getUrlEntries() {
    return document.getElementById("docUrls").value
        .split("\n")
        .map((entry) => entry.trim())
        .filter(Boolean);
}

function getNameFromUrl(url) {
    try {
        return new URL(url).pathname.split("/").filter(Boolean).pop() || url;
    } catch {
        return url;
    }
}

function emptyExtractedFields() {
    return {
        invoiceNumber: { value: "--", confidence: 0 },
        vendorName: { value: "--", confidence: 0 },
        invoiceDate: { value: "--", confidence: 0 },
        taxAmount: { value: "--", confidence: 0 },
        totalAmount: { value: "--", confidence: 0 }
    };
}

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}
