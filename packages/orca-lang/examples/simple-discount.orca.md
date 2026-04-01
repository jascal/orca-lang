# decision_table SimpleDiscount

## conditions

| Name | Type | Values |
|------|------|--------|
| tier | enum | gold, silver, bronze |
| is_holiday | bool | |

## actions

| Name | Type |
|------|------|
| discount_percent | enum | none, five, ten |

## rules

| tier | is_holiday | → discount_percent |
|------|------------|--------------------|
| gold | true | ten |
| gold | false | ten |
| silver | true | five |
| silver | false | none |
| bronze | true | none |
| bronze | false | none |
