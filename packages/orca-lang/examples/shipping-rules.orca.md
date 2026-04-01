# decision_table ShippingCost

## conditions

| Name | Type | Values |
|------|------|--------|
| weight_kg | int_range | 1..100 |
| zone | enum | domestic, international, remote |
| shipping_speed | enum | standard, express, overnight |

## actions

| Name | Type | Values |
|------|------|--------|
| base_cost | enum | base_5, base_10, base_20, base_50 |
| fuel_surcharge | bool | |
| delivery_days | enum | 3_5, 1_2, next_day |

## rules

| weight_kg | zone | shipping_speed | → base_cost | → fuel_surcharge | → delivery_days |
|-----------|------|----------------|------------|------------------|-----------------|
| 1..10 | domestic | standard | base_5 | false | 3_5 |
| 1..10 | domestic | express | base_10 | false | 1_2 |
| 1..10 | domestic | overnight | base_20 | false | next_day |
| 1..10 | international | standard | base_10 | true | 3_5 |
| 1..10 | international | express | base_20 | true | 1_2 |
| 1..10 | international | overnight | base_50 | true | next_day |
| 1..10 | remote | standard | base_10 | true | 3_5 |
| 1..10 | remote | express | base_20 | true | 1_2 |
| 1..10 | remote | overnight | base_50 | true | next_day |
| 11..50 | domestic | standard | base_10 | false | 3_5 |
| 11..50 | domestic | express | base_20 | false | 1_2 |
| 11..50 | domestic | overnight | base_50 | false | next_day |
| 11..50 | international | standard | base_20 | true | 3_5 |
| 11..50 | international | express | base_50 | true | 1_2 |
| 11..50 | international | overnight | base_50 | true | next_day |
| 11..50 | remote | standard | base_20 | true | 3_5 |
| 11..50 | remote | express | base_50 | true | 1_2 |
| 11..50 | remote | overnight | base_50 | true | next_day |
