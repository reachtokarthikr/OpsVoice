"""Tool implementations for the OpsVoice incident assistant."""

from __future__ import annotations

import logging
import os
import random
import re
import threading
import time
import uuid
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any

from google.adk.tools import ToolContext

try:
    from google.cloud import firestore
except ImportError:  # pragma: no cover - optional until dependencies are installed
    firestore = None

LOGGER = logging.getLogger("opsvoice.tools")

KNOWN_SERVICES = {"payment-api", "inventory-db", "checkout-worker", "auth-service", "notification-worker", "cdn-cache"}

SERVICE_HEALTH = {
    "payment-api": {
        "status": "degraded",
        "latency_ms_p95": 842,
        "error_rate_percent": 4.8,
        "cpu_percent": 79,
        "summary": "Elevated latency and error rate after the last rollout.",
    },
    "inventory-db": {
        "status": "critical",
        "latency_ms_p95": 1250,
        "error_rate_percent": 8.4,
        "cpu_percent": 96,
        "summary": "Database saturation detected. Writes are backing up.",
    },
    "checkout-worker": {
        "status": "healthy",
        "latency_ms_p95": 95,
        "error_rate_percent": 0.1,
        "cpu_percent": 42,
        "summary": "Background worker queue is processing within normal limits.",
    },
    "auth-service": {
        "status": "healthy",
        "latency_ms_p95": 45,
        "error_rate_percent": 0.2,
        "cpu_percent": 31,
        "summary": "Authentication service operating normally. OAuth token issuance within SLO.",
    },
    "notification-worker": {
        "status": "degraded",
        "latency_ms_p95": 620,
        "error_rate_percent": 3.1,
        "cpu_percent": 72,
        "summary": "Email delivery queue backing up. SMS channel unaffected.",
    },
    "cdn-cache": {
        "status": "healthy",
        "latency_ms_p95": 12,
        "error_rate_percent": 0.0,
        "cpu_percent": 18,
        "summary": "Cache hit ratio at 94.2%. All edge nodes responding.",
    },
}

RUNBOOKS = {
    ("payment-api", "high latency"): {
        "title": "Payment API high latency",
        "steps": [
            "Check the most recent deploy and rollback if error rate increased immediately after rollout.",
            "Inspect downstream dependency latency, especially inventory-db and payment gateway timeouts.",
            "Scale the service if CPU or request concurrency is saturated.",
            "Enable verbose request tracing for the slowest endpoint class.",
        ],
    },
    ("inventory-db", "high cpu"): {
        "title": "Inventory DB CPU saturation",
        "steps": [
            "Identify the top expensive queries and verify index coverage.",
            "Pause non-critical batch jobs that share the same database instance.",
            "Shift read-heavy traffic to replicas or cache layers if available.",
            "Escalate to the database owner if write latency remains above the SLO for 10 minutes.",
        ],
    },
    ("notification-worker", "high latency"): {
        "title": "Notification Worker Delivery Delays",
        "steps": [
            "Check email provider API status and rate limits.",
            "Inspect the dead-letter queue for stuck messages.",
            "Scale worker replicas if queue depth exceeds 10k.",
            "Failover to backup SMTP relay if primary is unresponsive.",
        ],
    },
    ("auth-service", "token errors"): {
        "title": "Auth Service Token Issuance Failures",
        "steps": [
            "Verify OAuth provider connectivity and certificate validity.",
            "Check token cache (Redis) memory and eviction rate.",
            "Review recent config changes to allowed scopes or redirect URIs.",
            "Rotate signing keys if compromise is suspected — coordinate with security team.",
        ],
    },
    ("cdn-cache", "low hit ratio"): {
        "title": "CDN Cache Hit Ratio Drop",
        "steps": [
            "Check if a recent deployment invalidated cache keys.",
            "Verify origin server health and response times.",
            "Review cache TTL configuration for affected content types.",
            "Check for cache-busting query parameters in recent frontend changes.",
        ],
    },
}

VALID_SEVERITIES = {"P1", "P2", "P3"}
VALID_STATUSES = {"OPEN", "INVESTIGATING", "MITIGATED", "RESOLVED"}

INCIDENTS_STATE_KEY = "app:incidents"
LOCAL_INCIDENTS: dict[str, dict[str, Any]] = {}
_incidents_lock = threading.Lock()

# Dynamic health simulation state
_simulation_start: float = 0.0
_dynamic_health_cache: dict[str, dict[str, Any]] = {}
_last_health_update: float = 0.0
_HEALTH_UPDATE_INTERVAL = 15.0  # seconds between health changes

# Alert tracking
_previous_statuses: dict[str, str] = {}
_pending_alerts: list[dict[str, Any]] = []
_alerts_lock = threading.Lock()


def _init_simulation() -> None:
    """Initialize the dynamic health simulation."""
    global _simulation_start, _dynamic_health_cache, _last_health_update
    _simulation_start = time.time()
    _dynamic_health_cache = deepcopy(SERVICE_HEALTH)
    _last_health_update = time.time()
    for svc, data in _dynamic_health_cache.items():
        _previous_statuses[svc] = data["status"]


def _evolve_health() -> None:
    """Evolve service health over time to simulate realistic scenarios."""
    global _last_health_update
    now = time.time()
    if now - _last_health_update < _HEALTH_UPDATE_INTERVAL:
        return
    _last_health_update = now
    elapsed = now - _simulation_start

    for svc, data in _dynamic_health_cache.items():
        # Add small random fluctuations
        data["latency_ms_p95"] = max(1, data["latency_ms_p95"] + random.randint(-20, 25))
        data["error_rate_percent"] = round(max(0, data["error_rate_percent"] + random.uniform(-0.3, 0.4)), 1)
        data["cpu_percent"] = max(1, min(100, data["cpu_percent"] + random.randint(-3, 4)))

        # Scenario: after 45 seconds, notification-worker goes critical
        if svc == "notification-worker" and elapsed > 45:
            data["status"] = "critical"
            data["latency_ms_p95"] = max(data["latency_ms_p95"], 1800 + random.randint(-100, 200))
            data["error_rate_percent"] = max(data["error_rate_percent"], 12.0 + random.uniform(-1, 2))
            data["cpu_percent"] = max(data["cpu_percent"], 92 + random.randint(-2, 5))
            data["summary"] = "Email and SMS delivery completely stalled. Dead-letter queue overflow."

        # Scenario: after 90 seconds, payment-api worsens to critical
        if svc == "payment-api" and elapsed > 90:
            data["status"] = "critical"
            data["latency_ms_p95"] = max(data["latency_ms_p95"], 2400 + random.randint(-200, 300))
            data["error_rate_percent"] = max(data["error_rate_percent"], 15.0 + random.uniform(-1, 3))
            data["cpu_percent"] = min(100, max(data["cpu_percent"], 94))
            data["summary"] = "Cascading failure from inventory-db. Payment timeouts causing checkout drops."

        # Update status based on metrics
        if data["status"] != "critical":
            if data["error_rate_percent"] > 5 or data["latency_ms_p95"] > 1000 or data["cpu_percent"] > 90:
                data["status"] = "critical"
            elif data["error_rate_percent"] > 2 or data["latency_ms_p95"] > 500 or data["cpu_percent"] > 70:
                data["status"] = "degraded"

        # Check for status transitions and generate alerts
        prev = _previous_statuses.get(svc, "healthy")
        curr = data["status"]
        if prev != curr and curr in ("critical", "degraded"):
            severity_map = {"critical": "P1", "degraded": "P2"}
            alert = {
                "type": "proactive_alert",
                "service": svc,
                "previous_status": prev,
                "current_status": curr,
                "severity": severity_map.get(curr, "P3"),
                "summary": data["summary"],
                "metrics": {
                    "latency_ms_p95": data["latency_ms_p95"],
                    "error_rate_percent": data["error_rate_percent"],
                    "cpu_percent": data["cpu_percent"],
                },
                "timestamp": _utc_now(),
            }
            with _alerts_lock:
                _pending_alerts.append(alert)
        _previous_statuses[svc] = curr


def get_dynamic_health() -> dict[str, dict[str, Any]]:
    """Get current dynamic health state, evolving the simulation."""
    if not _dynamic_health_cache:
        _init_simulation()
    _evolve_health()
    return deepcopy(_dynamic_health_cache)


def pop_pending_alerts() -> list[dict[str, Any]]:
    """Pop and return any pending proactive alerts."""
    with _alerts_lock:
        alerts = list(_pending_alerts)
        _pending_alerts.clear()
    return alerts


# Validation
_INCIDENT_ID_RE = re.compile(r"^[a-f0-9]{12}$")

# Maximum length constraints for free-text fields
_MAX_TITLE_LEN = 200
_MAX_DESCRIPTION_LEN = 2000
_MAX_NOTES_LEN = 2000


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalize(value: str) -> str:
    return value.strip().lower()


def _sanitize_text(value: str, max_len: int) -> str:
    """Strip and truncate free-text input."""
    return value.strip()[:max_len]


def _load_incidents_from_firestore() -> dict[str, dict[str, Any]]:
    """Fetch open incidents from Firestore for cross-instance consistency."""
    client = _get_firestore_client()
    if client is None:
        return {}
    try:
        docs = client.collection("incidents").where("status", "==", "OPEN").stream()
        return {doc.id: doc.to_dict() for doc in docs}
    except Exception:
        LOGGER.warning("Failed to read incidents from Firestore", exc_info=True)
        return {}


def _load_incidents(tool_context: ToolContext | None = None) -> dict[str, dict[str, Any]]:
    if tool_context is not None:
        incidents = tool_context.state.get(INCIDENTS_STATE_KEY)
        if isinstance(incidents, dict):
            merged = deepcopy(incidents)
            firestore_incidents = _load_incidents_from_firestore()
            for iid, record in firestore_incidents.items():
                if iid not in merged:
                    merged[iid] = record
            return merged
    with _incidents_lock:
        merged = deepcopy(LOCAL_INCIDENTS)
    firestore_incidents = _load_incidents_from_firestore()
    for iid, record in firestore_incidents.items():
        if iid not in merged:
            merged[iid] = record
    return merged


def _save_incidents(tool_context: ToolContext | None, incidents: dict[str, dict[str, Any]]) -> None:
    copied = deepcopy(incidents)
    with _incidents_lock:
        LOCAL_INCIDENTS.clear()
        LOCAL_INCIDENTS.update(copied)
    if tool_context is not None:
        tool_context.state[INCIDENTS_STATE_KEY] = deepcopy(incidents)


_firestore_cache: dict[str, Any] = {"client": None, "created_at": 0.0}
_FIRESTORE_TTL = 3600  # re-create client every hour


def _firestore_is_configured() -> bool:
    if firestore is None:
        return False
    if os.getenv("OPSVOICE_DISABLE_FIRESTORE", "").strip().lower() in {"1", "true", "yes", "on"}:
        return False
    if not os.getenv("GOOGLE_CLOUD_PROJECT"):
        return False
    if os.getenv("GOOGLE_APPLICATION_CREDENTIALS"):
        return True
    return os.getenv("OPSVOICE_ENABLE_FIRESTORE", "").strip().lower() in {"1", "true", "yes", "on"}


def _get_firestore_client():
    if not _firestore_is_configured():
        return None
    project_id = os.getenv("GOOGLE_CLOUD_PROJECT")
    now = time.time()
    if _firestore_cache["client"] is not None and now - _firestore_cache["created_at"] < _FIRESTORE_TTL:
        return _firestore_cache["client"]
    try:
        client = firestore.Client(project=project_id)
        _firestore_cache["client"] = client
        _firestore_cache["created_at"] = now
        return client
    except Exception:
        LOGGER.warning(
            "Failed to create Firestore client. Set GOOGLE_APPLICATION_CREDENTIALS for ADC, "
            "or disable Firestore for local runs with OPSVOICE_DISABLE_FIRESTORE=true.",
            exc_info=True,
        )
        _firestore_cache["client"] = None
        return None


def check_service_health(service: str, tool_context: ToolContext) -> dict[str, Any]:
    """Check the current health status of a service. Call this FIRST before making any claims about service state.

    Args:
        service: Service name to check. Known services: "payment-api", "inventory-db", "checkout-worker".
        tool_context: Automatically provided execution context.

    Returns a dict with: status (healthy/degraded/critical), latency_ms_p95, error_rate_percent, cpu_percent, summary, checked_at.
    If the service is unknown, returns supported_services list.
    """
    service_key = _normalize(service)
    tool_context.state["temp:last_service"] = service_key
    dynamic = get_dynamic_health()
    payload = dynamic.get(service_key)
    if not payload:
        return {
            "service": service,
            "status": "unknown",
            "message": (
                "No health snapshot is available for this service in the local scaffold. "
                "Use google_search for external context or add a real monitoring integration."
            ),
            "supported_services": sorted(dynamic),
        }
    return {"service": service_key, **payload, "checked_at": _utc_now()}


def create_incident(
    title: str,
    service: str,
    severity: str,
    description: str,
    tool_context: ToolContext,
) -> dict[str, Any]:
    """Create a new incident record. Only call after confirming severity with the user or when the situation clearly warrants it.

    Args:
        title: Short descriptive title, e.g. "Payment API latency spike after deploy".
        service: Affected service name (e.g. "payment-api", "inventory-db").
        severity: P1 (outage/revenue impact), P2 (degraded/SLO breach), or P3 (minor/no customer impact).
        description: Detailed description including symptoms, timeline, and initial observations.
        tool_context: Automatically provided execution context.

    Returns the created incident record with incident_id, status "OPEN", and timestamps.
    """
    severity_upper = severity.strip().upper()
    if severity_upper not in VALID_SEVERITIES:
        return {
            "status": "error",
            "message": f"Invalid severity '{severity}'. Must be one of: {', '.join(sorted(VALID_SEVERITIES))}.",
        }

    service_key = _normalize(service)
    incident_id = uuid.uuid4().hex[:12]
    record = {
        "incident_id": incident_id,
        "title": _sanitize_text(title, _MAX_TITLE_LEN),
        "service": service_key,
        "severity": severity_upper,
        "description": _sanitize_text(description, _MAX_DESCRIPTION_LEN),
        "status": "OPEN",
        "created_at": _utc_now(),
        "updated_at": _utc_now(),
        "storage": "session",
    }

    client = _get_firestore_client()
    if client is not None:
        try:
            firestore_record = {**record, "storage": "firestore"}
            client.collection("incidents").document(incident_id).set(firestore_record)
            record = firestore_record
        except Exception:
            LOGGER.warning("Failed to write incident %s to Firestore", incident_id, exc_info=True)

    incidents = _load_incidents(tool_context)
    incidents[incident_id] = record
    _save_incidents(tool_context, incidents)
    tool_context.state["temp:last_incident_id"] = incident_id
    return record


def get_open_incidents(
    service: str | None = None,
    severity: str | None = None,
    tool_context: ToolContext | None = None,
) -> dict[str, Any]:
    """List all currently open incidents. Call this to check if an incident already exists before creating a new one.

    Args:
        service: Optional filter by service name (e.g. "payment-api"). Omit to list all.
        severity: Optional filter by severity level (P1, P2, or P3). Omit to list all.
        tool_context: Automatically provided execution context.

    Returns a dict with count, items (sorted newest first), and applied filters.
    """
    service_filter = _normalize(service) if service else None
    severity_filter = severity.strip().upper() if severity else None

    items = []
    for incident in _load_incidents(tool_context).values():
        if incident.get("status") != "OPEN":
            continue
        if service_filter and incident.get("service") != service_filter:
            continue
        if severity_filter and incident.get("severity") != severity_filter:
            continue
        items.append(incident)

    items.sort(key=lambda item: item["created_at"], reverse=True)
    return {
        "count": len(items),
        "items": items,
        "filters": {"service": service_filter, "severity": severity_filter},
    }


def get_incident_snapshot(
    service: str | None = None,
    severity: str | None = None,
) -> dict[str, Any]:
    """Return the current incident list for dashboard/API consumers outside a live tool context."""
    return get_open_incidents(service=service, severity=severity, tool_context=None)


def update_incident_status(
    incident_id: str,
    status: str,
    resolution_notes: str = "",
    tool_context: ToolContext | None = None,
) -> dict[str, Any]:
    """Update the status of an existing incident. Use get_open_incidents first to find the incident_id.

    Args:
        incident_id: The 12-character incident ID returned by create_incident or get_open_incidents.
        status: New status — one of: OPEN, INVESTIGATING, MITIGATED, RESOLVED.
        resolution_notes: Optional notes describing what was done (required when resolving).
        tool_context: Automatically provided execution context.

    Returns the updated incident record, or {status: "not_found"} if the ID is invalid.
    """
    if tool_context is None:
        return {"status": "error", "message": "Tool context is required."}

    incident_id = incident_id.strip()
    if not _INCIDENT_ID_RE.match(incident_id):
        return {"status": "error", "message": "Invalid incident_id format. Expected 12-character hex string."}

    normalized_status = status.strip().upper()
    if normalized_status not in VALID_STATUSES:
        return {
            "status": "error",
            "message": f"Invalid status '{status}'. Must be one of: {', '.join(sorted(VALID_STATUSES))}.",
        }

    incidents = _load_incidents(tool_context)
    incident = incidents.get(incident_id)
    if not incident:
        return {"status": "not_found", "incident_id": incident_id}

    incident["status"] = normalized_status
    incident["updated_at"] = _utc_now()
    sanitized_notes = _sanitize_text(resolution_notes, _MAX_NOTES_LEN)
    if sanitized_notes:
        incident["resolution_notes"] = sanitized_notes
    incidents[incident_id] = incident
    _save_incidents(tool_context, incidents)

    client = _get_firestore_client()
    if client is not None:
        try:
            firestore_record = {**incident, "storage": "firestore"}
            client.collection("incidents").document(incident_id).set(firestore_record, merge=True)
            incident = firestore_record
        except Exception:
            LOGGER.warning("Failed to update incident %s in Firestore", incident_id, exc_info=True)

    return incident


def get_runbook(service: str, issue: str, tool_context: ToolContext) -> dict[str, Any]:
    """Retrieve the incident response runbook for a specific service and issue type. Call this after check_service_health to get actionable steps.

    Args:
        service: Service name (e.g. "payment-api", "inventory-db").
        issue: Issue type describing the problem. Known issues: "high latency", "high cpu". Use short descriptive phrases.
        tool_context: Automatically provided execution context.

    Returns runbook steps if found, or a list of available runbooks if no match exists.
    """
    service_key = _normalize(service)
    issue_key = _normalize(issue)
    tool_context.state["temp:last_runbook_lookup"] = f"{service_key}:{issue_key}"

    runbook = RUNBOOKS.get((service_key, issue_key))
    if runbook:
        return {"service": service_key, "issue": issue_key, **runbook}

    # Try to find a runbook for the same service (any issue)
    same_service = [
        (svc, prob, details)
        for (svc, prob), details in RUNBOOKS.items()
        if svc == service_key
    ]
    if same_service:
        # Pick the first match for that service
        _, matched_issue, fallback = same_service[0]
        return {
            "service": service_key,
            "issue": issue_key,
            "matched_issue": matched_issue,
            **fallback,
            "note": f"Exact issue '{issue_key}' not found. Returning runbook for '{matched_issue}' on the same service.",
        }

    # No runbook for this service at all
    available = [
        {"service": svc, "issue": problem, "title": details["title"]}
        for (svc, problem), details in sorted(RUNBOOKS.items())
    ]
    return {
        "service": service_key,
        "issue": issue_key,
        "message": f"No runbook available for service '{service_key}'. Try google_search for external guidance.",
        "available_runbooks": available,
    }
