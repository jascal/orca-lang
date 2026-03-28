# machine TripCoordinator

## context

| Field | Type |
|-------|------|
| rider_id | string |
| pickup | string |
| destination | string |
| driver_id | string |
| payment_method | string |
| estimated_fare | number |
| actual_distance | number |
| actual_duration | number |
| surge_multiplier | number |
| pre_auth_id | string |

## events

- REQUEST_TRIP
- DRIVER_ASSIGNED
- PAYMENT_AUTHORIZED
- PAYMENT_DECLINED
- RIDER_PICKED_UP
- RIDER_DROPPED_OFF
- RIDER_CANCEL
- NO_SHOW
- TRIP_COMPLETE
- SETTLEMENT_COMPLETE
- SETTLEMENT_FAILED

## state idle [initial]
> Waiting for trip request

## state requesting [parallel]
> Find driver and authorize payment concurrently

### region matching [initial]

#### state finding_driver [initial]
> Searching for nearby drivers
- invoke: DriverMatching input: { pickup: ctx.pickup, destination: ctx.destination }

#### state matched [final]
> Driver found and confirmed

#### state no_drivers [final]
> No drivers available

### region payment

#### state authorizing [initial]
> Pre-authorizing payment
- invoke: PaymentAuth input: { payment_method: ctx.payment_method, estimated_fare: ctx.estimated_fare }

#### state authorized [final]
> Payment pre-authorized

#### state declined [final]
> Payment declined

## state pickup
> Driver en route to pickup
- timeout: 10m -> no_show
- invoke: TripExecution input: { driver_id: ctx.driver_id, pickup: ctx.pickup, destination: ctx.destination }

## state in_trip
> Trip in progress

## state completing
> Settling fare
- invoke: FareSettlement input: { actual_distance: ctx.actual_distance, actual_duration: ctx.actual_duration, surge_multiplier: ctx.surge_multiplier, pre_auth_id: ctx.pre_auth_id, driver_id: ctx.driver_id }

## state completed [final]
> Trip complete

## state no_show [final]
> Rider no-show

## state cancelled [final]
> Trip cancelled

## state failed [final]
> Unrecoverable error

## transitions

| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| idle | REQUEST_TRIP | | requesting | |
| requesting | DRIVER_ASSIGNED | | pickup | |
| requesting | PAYMENT_DECLINED | | failed | |
| requesting | NO_DRIVERS | | cancelled | |
| pickup | RIDER_PICKED_UP | | in_trip | |
| pickup | NO_SHOW | | no_show | |
| in_trip | RIDER_DROPPED_OFF | | completing | |
| completing | SETTLEMENT_COMPLETE | | completed | |
| completing | SETTLEMENT_FAILED | | failed | |
| idle | RIDER_CANCEL | | cancelled | |
| requesting | RIDER_CANCEL | | cancelled | |
| pickup | RIDER_CANCEL | | cancelled | |
| in_trip | RIDER_CANCEL | | cancelled | |

## effects

| Name         | Input                                                 | Output                  |
|--------------|-------------------------------------------------------|-------------------------|
| NotifyRider  | `{ rider_id: string, message: string }`               | `{ delivered: bool }`   |
| NotifyDriver | `{ driver_id: string, message: string }`              | `{ delivered: bool }`   |

---

# machine DriverMatching

## context

| Field | Type |
|-------|------|
| pickup | string |
| destination | string |

## events

- SEARCH_COMPLETE
- OFFER_SENT
- DRIVER_ACCEPTED
- DRIVER_DECLINED
- OFFER_TIMEOUT
- ALL_DECLINED

## state searching [initial]
> Querying nearby drivers

## state offering
> Offer sent to driver
- timeout: 15s -> searching

## state driver_accepted
> Driver accepted the trip

## state matched [final]
> Driver locked in

## state no_drivers [final]
> No drivers available

## transitions

| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| searching | SEARCH_COMPLETE | | offering | |
| offering | DRIVER_ACCEPTED | | driver_accepted | |
| offering | DRIVER_DECLINED | | searching | |
| offering | OFFER_TIMEOUT | | searching | |
| offering | ALL_DECLINED | | no_drivers | |
| driver_accepted | | | matched | |

---

# machine PaymentAuth

## context

| Field | Type |
|-------|------|
| payment_method | string |
| estimated_fare | number |

## events

- FARE_ESTIMATED
- AUTH_SUCCESS
- AUTH_DECLINED

## guards

| Name | Expression |
|------|------------|
| sufficient_funds | ctx.estimated_fare < 1000 |

## state estimating [initial]
> Calculating fare estimate

## state authorizing
> Pre-authorizing payment hold

## state authorized [final]
> Payment authorized

## state declined [final]
> Payment declined

## transitions

| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| estimating | FARE_ESTIMATED | | authorizing | |
| authorizing | AUTH_SUCCESS | sufficient_funds | authorized | |
| authorizing | AUTH_DECLINED | | declined | |

---

# machine TripExecution

## context

| Field | Type |
|-------|------|
| driver_id | string |
| pickup | string |
| destination | string |

## events

- DRIVER_EN_ROUTE
- ARRIVED_AT_PICKUP
- RIDER_IN
- TRIP_STARTED
- ARRIVED_AT_DESTINATION
- RIDER_OUT

## state en_route [initial]
> Driver heading to pickup

## state arrived_pickup
> Driver arrived, waiting for rider
- timeout: 5m -> trip_abandoned

## state rider_boarding
> Rider getting in

## state navigating
> Trip in progress

## state arrived_destination
> Arrived at destination

## state trip_complete [final]
> Trip finished successfully

## state trip_abandoned [final]
> Trip abandoned

## transitions

| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| en_route | ARRIVED_AT_PICKUP | | arrived_pickup | |
| arrived_pickup | RIDER_IN | | rider_boarding | |
| arrived_pickup | | | trip_abandoned | |
| rider_boarding | TRIP_STARTED | | navigating | |
| navigating | ARRIVED_AT_DESTINATION | | arrived_destination | |
| arrived_destination | RIDER_OUT | | trip_complete | |

---

# machine FareSettlement

## context

| Field | Type |
|-------|------|
| actual_distance | number |
| actual_duration | number |
| surge_multiplier | number |
| pre_auth_id | string |
| driver_id | string |

## events

- FARE_CALCULATED
- RIDER_CHARGED
- DRIVER_PAID
- RECEIPTS_SENT
- CHARGE_FAILED
- TRANSFER_FAILED

## state calculating [initial]
> Computing actual fare

## state charging_rider
> Capturing pre-authorized payment

## state paying_driver
> Transferring driver payment

## state issuing_receipt
> Generating receipts

## state settled [final]
> All payments complete

## state settlement_error [final]
> Payment failed

## transitions

| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| calculating | FARE_CALCULATED | | charging_rider | |
| charging_rider | RIDER_CHARGED | | paying_driver | |
| charging_rider | CHARGE_FAILED | | settlement_error | |
| paying_driver | DRIVER_PAID | | issuing_receipt | |
| paying_driver | TRANSFER_FAILED | | settlement_error | |
| issuing_receipt | RECEIPTS_SENT | | settled | |

## effects

| Name          | Input                                                                                  | Output                       |
|---------------|----------------------------------------------------------------------------------------|------------------------------|
| CalculateFare | `{ actual_distance: number, actual_duration: number, surge_multiplier: number }`       | `{ final_fare: number }`     |
| ChargeRider   | `{ pre_auth_id: string, final_fare: number }`                                          | `{ charge_id: string }`      |
| PayDriver     | `{ driver_id: string, driver_amount: number }`                                         | `{ transfer_id: string }`    |
| IssueReceipt  | `{ rider_id: string, driver_id: string, final_fare: number }`                          | `{ receipt_id: string }`     |
