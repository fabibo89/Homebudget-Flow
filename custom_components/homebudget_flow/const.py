from datetime import timedelta

DOMAIN = "homebudget_flow"

CONF_API_URL = "api_url"
CONF_EMAIL = "email"
CONF_PASSWORD = "password"
CONF_SCAN_INTERVAL_SECONDS = "scan_interval_seconds"

DEFAULT_SCAN_INTERVAL = timedelta(minutes=15)
DEFAULT_SCAN_INTERVAL_SECONDS = int(DEFAULT_SCAN_INTERVAL.total_seconds())

MIN_SCAN_INTERVAL_SECONDS = 60
