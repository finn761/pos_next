/**
 * Cashflows payment flow composable.
 *
 * Handles the round-trip from the iPad to the coag_cashflows backend, which in
 * turn drives the physical SUNMI P3 terminal bound to this station.
 *
 * Station identity is read from `?station=STATION-X` in the URL on first visit
 * and persisted in localStorage thereafter. Each iPad is pinned to exactly one
 * terminal; switching stations is an explicit URL change.
 *
 * Usage:
 *   const cashflows = useCashflowsPayment()
 *   const result = await cashflows.startFlow(amountInPence, posInvoiceName)
 */

import { ref } from "vue"
import { createResource } from "frappe-ui"
import { logger } from "@/utils/logger"

const log = logger.create("Cashflows")

const STATION_LOCAL_KEY = "coag_cashflows_station"
const POLL_INTERVAL_MS = 500
const TOTAL_TIMEOUT_MS = 150_000

/**
 * Resolve the station bound to this iPad.
 *
 * Order of precedence:
 *   1. `?station=STATION-X` in the current URL (and persist it to localStorage)
 *   2. Previously persisted value in localStorage
 *   3. Empty string — caller must refuse to take payment in this case
 *
 * @returns {string} Station ID, uppercased, or "" if unconfigured.
 */
export function getStationId() {
	if (typeof window === "undefined") {
		return ""
	}
	const params = new URLSearchParams(window.location.search)
	const fromUrl = params.get("station")
	if (fromUrl) {
		const normalised = fromUrl.trim().toUpperCase()
		try {
			window.localStorage.setItem(STATION_LOCAL_KEY, normalised)
		} catch (_) {
			// localStorage may be unavailable (private mode). Ignore.
		}
		return normalised
	}
	try {
		return (window.localStorage.getItem(STATION_LOCAL_KEY) || "").toUpperCase()
	} catch (_) {
		return ""
	}
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * @typedef {Object} CashflowsResult
 * @property {string} txn_id
 * @property {string} status       Terminal final state e.g. "approved".
 * @property {string} [result]     "approved" | "declined" | "cancelled" | ...
 * @property {string} [auth_code]
 * @property {string} [card_brand]
 * @property {string} [last_4]
 * @property {string} [merchant_id]
 * @property {string} [reference_number]
 */

export function useCashflowsPayment() {
	const isInFlight = ref(false)
	const status = ref("")
	const amountPence = ref(0)
	const stationId = ref("")
	const lastError = ref("")

	// Progression state for multi-card splits. `totalCards === 1` means the
	// overlay should render without the "Card X of Y" label.
	const currentCard = ref(1)
	const totalCards = ref(1)

	// Used to break out of the poll loop on user cancel.
	let aborted = false

	const initiateResource = createResource({
		url: "coag_cashflows.api.payments.initiate_payment",
		auto: false,
	})

	const checkResource = createResource({
		url: "coag_cashflows.api.payments.check_payment_status",
		auto: false,
	})

	/**
	 * Run the full initiate → poll → resolve flow for a single card.
	 *
	 * @param {number} pence       Amount in pence (integer, >= 1).
	 * @param {object} [opts]
	 * @param {string|null} [opts.posInvoice]
	 *        Optional POS Invoice name. If provided, the backend stamps
	 *        custom_cashflows_* fields onto the invoice on approval.
	 * @param {number} [opts.index]  1-based index for progression display.
	 * @param {number} [opts.total]  Total number of cards in this split.
	 * @returns {Promise<CashflowsResult>}
	 * @throws {Error}             Any non-approved outcome (declined, cancelled,
	 *                             timeout, configuration error) is thrown.
	 */
	async function startFlow(pence, opts = {}) {
		const posInvoice = opts.posInvoice || null
		currentCard.value = opts.index || 1
		totalCards.value = opts.total || 1
		const station = getStationId()
		if (!station) {
			throw new Error(
				"This iPad is not configured for a Cashflows station. " +
					"Load the POS with ?station=STATION-1 (or STATION-2) in the URL.",
			)
		}

		if (!Number.isInteger(pence) || pence < 1) {
			throw new Error("Invalid payment amount")
		}

		aborted = false
		isInFlight.value = true
		stationId.value = station
		amountPence.value = pence
		status.value = "connecting"
		lastError.value = ""

		try {
			const started = await initiateResource.submit({
				terminal_id: station,
				amount_pence: pence,
				pos_invoice: posInvoice || "",
			})
			const txnId = started && started.txn_id
			if (!txnId) {
				throw new Error("No transaction id returned from initiate_payment")
			}

			log.debug("[cashflows] initiated", { station, txnId, pence })
			status.value = "waiting for card"

			const deadline = Date.now() + TOTAL_TIMEOUT_MS
			while (Date.now() < deadline) {
				if (aborted) {
					throw new Error("Payment cancelled")
				}
				await delay(POLL_INTERVAL_MS)
				const state = await checkResource.submit({
					terminal_id: station,
					txn_id: txnId,
					pos_invoice: posInvoice || "",
				})
				if (state && state.status) {
					status.value = state.status
				}
				if (state && !state.is_active) {
					log.debug("[cashflows] finished", {
						txnId,
						result: state.result,
						status: state.status,
					})
					if (state.result === "approved") {
						return state
					}
					const details = state.status_details ? `: ${state.status_details}` : ""
					throw new Error(`Payment ${state.result || "not approved"}${details}`)
				}
			}
			throw new Error("Payment timed out")
		} catch (err) {
			lastError.value = err && err.message ? err.message : String(err)
			throw err
		} finally {
			isInFlight.value = false
		}
	}

	/** Abort the in-flight poll loop. The terminal itself may keep running until its own timeout. */
	function cancel() {
		aborted = true
	}

	return {
		isInFlight,
		status,
		amountPence,
		stationId,
		lastError,
		currentCard,
		totalCards,
		startFlow,
		cancel,
	}
}
