module demo_actions
  use, intrinsic :: iso_c_binding
  implicit none

  ! Static result buffers — one per action, persists between calls.
  ! Each action writes its JSON result here and returns a pointer to it.
  character(len=512), save, target :: result_produce
  character(len=512), save, target :: result_cut_price
  character(len=512), save, target :: result_raise_price
  character(len=512), save, target :: result_buy
  character(len=512), save, target :: result_sell
  character(len=512), save, target :: result_hold
  character(len=512), save, target :: result_maybe_buy
  character(len=512), save, target :: result_update_price

  ! Shared market price (set by main program each tick)
  real(c_double), save :: current_market_price = 10.0d0

  ! Random seed state for speculator
  logical, save :: rng_initialized = .false.

contains

  ! -- JSON helpers --
  ! Extract a numeric value from JSON by key name.
  ! Extremely minimal: finds "key": and reads the number after it.
  function json_get_number(json_str, key) result(val)
    character(len=*), intent(in) :: json_str, key
    real(c_double) :: val
    integer :: pos, colon_pos, end_pos
    character(len=256) :: num_str

    val = 0.0d0
    ! Find "key":
    pos = index(json_str, '"' // trim(key) // '"')
    if (pos == 0) return

    colon_pos = index(json_str(pos:), ':')
    if (colon_pos == 0) return
    colon_pos = pos + colon_pos  ! absolute position after ':'

    ! Skip whitespace
    do while (colon_pos <= len_trim(json_str) .and. &
              (json_str(colon_pos:colon_pos) == ' ' .or. &
               json_str(colon_pos:colon_pos) == char(9)))
      colon_pos = colon_pos + 1
    end do

    ! Read until comma, brace, or end
    end_pos = colon_pos
    do while (end_pos <= len_trim(json_str))
      if (json_str(end_pos:end_pos) == ',' .or. &
          json_str(end_pos:end_pos) == '}' .or. &
          json_str(end_pos:end_pos) == ' ') exit
      end_pos = end_pos + 1
    end do

    num_str = json_str(colon_pos:end_pos-1)
    read(num_str, *, err=999) val
    return
999 val = 0.0d0
  end function

  ! Build a JSON object string with one numeric field
  subroutine json_one_number(buf, key, val)
    character(len=*), intent(out) :: buf
    character(len=*), intent(in)  :: key
    real(c_double), intent(in)    :: val
    character(len=64) :: num_str

    ! Format the number — use integer format if it's a whole number
    if (abs(val - nint(val)) < 1.0d-9) then
      write(num_str, '(I0)') nint(val)
    else
      write(num_str, '(F12.1)') val
      num_str = adjustl(num_str)
    end if

    buf = '{"' // trim(key) // '":' // trim(num_str) // '}'
    ! Null-terminate for C
    buf(len_trim(buf)+1:len_trim(buf)+1) = char(0)
  end subroutine

  ! Build a JSON object with two numeric fields
  subroutine json_two_numbers(buf, key1, val1, key2, val2)
    character(len=*), intent(out) :: buf
    character(len=*), intent(in)  :: key1, key2
    real(c_double), intent(in)    :: val1, val2
    character(len=64) :: num1, num2

    if (abs(val1 - nint(val1)) < 1.0d-9) then
      write(num1, '(I0)') nint(val1)
    else
      write(num1, '(F12.1)') val1
      num1 = adjustl(num1)
    end if

    if (abs(val2 - nint(val2)) < 1.0d-9) then
      write(num2, '(I0)') nint(val2)
    else
      write(num2, '(F12.1)') val2
      num2 = adjustl(num2)
    end if

    buf = '{"' // trim(key1) // '":' // trim(num1) // ',"' // &
          trim(key2) // '":' // trim(num2) // '}'
    buf(len_trim(buf)+1:len_trim(buf)+1) = char(0)
  end subroutine

  ! -- Producer actions --

  ! produce: inventory += 10, nudge price based on inventory level
  function action_produce(ctx_json, event_json) result(res_ptr) bind(C)
    type(c_ptr), value, intent(in) :: ctx_json, event_json
    type(c_ptr) :: res_ptr
    character(len=4096), pointer :: ctx_str
    real(c_double) :: inventory, price

    call c_f_pointer(ctx_json, ctx_str)
    inventory = json_get_number(ctx_str, 'inventory')
    price = json_get_number(ctx_str, 'price')
    inventory = inventory + 10.0d0
    ! High inventory -> lower price, low inventory -> raise price
    if (inventory > 200.0d0) then
      price = price - 0.1d0
    else if (inventory < 50.0d0) then
      price = price + 0.1d0
    end if
    if (price < 1.0d0) price = 1.0d0
    call json_two_numbers(result_produce, 'inventory', inventory, 'price', price)
    res_ptr = c_loc(result_produce)
  end function

  ! cut_price: price -= 1.0
  function action_cut_price(ctx_json, event_json) result(res_ptr) bind(C)
    type(c_ptr), value, intent(in) :: ctx_json, event_json
    type(c_ptr) :: res_ptr
    character(len=4096), pointer :: ctx_str
    real(c_double) :: price

    call c_f_pointer(ctx_json, ctx_str)
    price = json_get_number(ctx_str, 'price')
    call json_one_number(result_cut_price, 'price', price - 1.0d0)
    res_ptr = c_loc(result_cut_price)
  end function

  ! raise_price: price += 1.0
  function action_raise_price(ctx_json, event_json) result(res_ptr) bind(C)
    type(c_ptr), value, intent(in) :: ctx_json, event_json
    type(c_ptr) :: res_ptr
    character(len=4096), pointer :: ctx_str
    real(c_double) :: price

    call c_f_pointer(ctx_json, ctx_str)
    price = json_get_number(ctx_str, 'price')
    call json_one_number(result_raise_price, 'price', price + 1.0d0)
    res_ptr = c_loc(result_raise_price)
  end function

  ! -- Consumer actions --

  ! buy: goods += 1, cash -= market_price
  function action_buy(ctx_json, event_json) result(res_ptr) bind(C)
    type(c_ptr), value, intent(in) :: ctx_json, event_json
    type(c_ptr) :: res_ptr
    character(len=4096), pointer :: ctx_str
    real(c_double) :: goods, cash

    call c_f_pointer(ctx_json, ctx_str)
    goods = json_get_number(ctx_str, 'goods')
    cash  = json_get_number(ctx_str, 'cash')
    call json_two_numbers(result_buy, 'goods', goods + 1.0d0, &
                          'cash', cash - current_market_price)
    res_ptr = c_loc(result_buy)
  end function

  ! sell: goods -= 1, cash += market_price
  function action_sell(ctx_json, event_json) result(res_ptr) bind(C)
    type(c_ptr), value, intent(in) :: ctx_json, event_json
    type(c_ptr) :: res_ptr
    character(len=4096), pointer :: ctx_str
    real(c_double) :: goods, cash

    call c_f_pointer(ctx_json, ctx_str)
    goods = json_get_number(ctx_str, 'goods')
    cash  = json_get_number(ctx_str, 'cash')
    if (goods > 0.0d0) then
      call json_two_numbers(result_sell, 'goods', goods - 1.0d0, &
                            'cash', cash + current_market_price)
    else
      result_sell = '{}' // char(0)
    end if
    res_ptr = c_loc(result_sell)
  end function

  ! hold: no-op
  function action_hold(ctx_json, event_json) result(res_ptr) bind(C)
    type(c_ptr), value, intent(in) :: ctx_json, event_json
    type(c_ptr) :: res_ptr
    result_hold = '{}' // char(0)
    res_ptr = c_loc(result_hold)
  end function

  ! -- Speculator actions --

  ! maybe_buy: randomly buy (50% chance) — randomness is in the action, not the guard
  function action_maybe_buy(ctx_json, event_json) result(res_ptr) bind(C)
    type(c_ptr), value, intent(in) :: ctx_json, event_json
    type(c_ptr) :: res_ptr
    character(len=4096), pointer :: ctx_str
    real(c_double) :: cash, position
    real :: rand_val

    if (.not. rng_initialized) then
      call random_seed()
      rng_initialized = .true.
    end if

    call c_f_pointer(ctx_json, ctx_str)
    cash     = json_get_number(ctx_str, 'cash')
    position = json_get_number(ctx_str, 'position')

    call random_number(rand_val)
    if (rand_val > 0.5 .and. position < 0.5d0 .and. cash > current_market_price) then
      call json_two_numbers(result_maybe_buy, 'position', 1.0d0, &
                            'cash', cash - current_market_price)
    else
      result_maybe_buy = '{}' // char(0)
    end if
    res_ptr = c_loc(result_maybe_buy)
  end function

  ! -- Shared action: update price from market --

  ! update_price: sets agent's price to current market price
  function action_update_price(ctx_json, event_json) result(res_ptr) bind(C)
    type(c_ptr), value, intent(in) :: ctx_json, event_json
    type(c_ptr) :: res_ptr
    call json_one_number(result_update_price, 'price', current_market_price)
    res_ptr = c_loc(result_update_price)
  end function

end module demo_actions
