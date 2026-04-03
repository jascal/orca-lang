program market_simulation
  use, intrinsic :: iso_c_binding
  use orca_ffi
  use demo_actions
  implicit none

  ! Agent counts
  integer, parameter :: N_PRODUCERS   = 20
  integer, parameter :: N_CONSUMERS   = 50
  integer, parameter :: N_SPECULATORS = 10
  integer, parameter :: N_TICKS       = 100

  ! Machine handles
  type(c_ptr) :: producers(N_PRODUCERS)
  type(c_ptr) :: consumers(N_CONSUMERS)
  type(c_ptr) :: speculators(N_SPECULATORS)

  ! Market state
  real(c_double) :: market_price
  real(c_double) :: total_inventory, total_cash, total_goods, total_spec_cash
  integer :: i, tick, rc

  ! State/context query buffers
  character(len=2048) :: state_buf
  integer(c_size_t) :: actual_len

  ! Event JSON buffers
  character(len=256) :: price_event
  character(len=64)  :: price_str

  ! Machine definition strings — read from files embedded as string constants
  character(len=:), allocatable :: producer_md, consumer_md, speculator_md

  ! ============================================================
  ! Load machine definitions
  ! ============================================================
  call load_file('orca/producer.orca.md', producer_md)
  call load_file('orca/consumer.orca.md', consumer_md)
  call load_file('orca/speculator.orca.md', speculator_md)

  write(*,'(A)') '================================================================'
  write(*,'(A)') '  Orca Market Simulation — Fortran FFI Demo'
  write(*,'(A)') '================================================================'
  write(*,'(A,I0,A,I0,A,I0,A)') '  Agents: ', N_PRODUCERS, ' producers, ', &
       N_CONSUMERS, ' consumers, ', N_SPECULATORS, ' speculators'
  write(*,'(A,I0,A)') '  Running ', N_TICKS, ' ticks'
  write(*,'(A)') '================================================================'
  write(*,*)

  ! ============================================================
  ! 1. Initialize all agents
  ! ============================================================
  do i = 1, N_PRODUCERS
    rc = orca_init_str(producer_md, producers(i))
    if (rc /= ORCA_OK) then
      write(*,'(A,I0,A,I0)') 'ERROR: Failed to init producer ', i, ' rc=', rc
      stop 1
    end if
    rc = orca_register_action_str(producers(i), 'produce', c_funloc(action_produce))
    rc = orca_register_action_str(producers(i), 'cut_price', c_funloc(action_cut_price))
    rc = orca_register_action_str(producers(i), 'raise_price', c_funloc(action_raise_price))
    rc = orca_register_action_str(producers(i), 'update_price', c_funloc(action_update_price))
  end do

  do i = 1, N_CONSUMERS
    rc = orca_init_str(consumer_md, consumers(i))
    if (rc /= ORCA_OK) then
      write(*,'(A,I0,A,I0)') 'ERROR: Failed to init consumer ', i, ' rc=', rc
      stop 1
    end if
    rc = orca_register_action_str(consumers(i), 'buy', c_funloc(action_buy))
    rc = orca_register_action_str(consumers(i), 'sell', c_funloc(action_sell))
    rc = orca_register_action_str(consumers(i), 'hold', c_funloc(action_hold))
    rc = orca_register_action_str(consumers(i), 'update_price', c_funloc(action_update_price))
  end do

  do i = 1, N_SPECULATORS
    rc = orca_init_str(speculator_md, speculators(i))
    if (rc /= ORCA_OK) then
      write(*,'(A,I0,A,I0)') 'ERROR: Failed to init speculator ', i, ' rc=', rc
      stop 1
    end if
    rc = orca_register_action_str(speculators(i), 'maybe_buy', c_funloc(action_maybe_buy))
    rc = orca_register_action_str(speculators(i), 'update_price', c_funloc(action_update_price))
  end do

  write(*,'(A,I0,A)') '  Initialized ', N_PRODUCERS + N_CONSUMERS + N_SPECULATORS, ' agents'

  ! ============================================================
  ! 2. Run simulation
  ! ============================================================
  market_price = 10.0d0

  do tick = 1, N_TICKS
    ! Update shared market price for action callbacks
    current_market_price = market_price

    ! 2a. Send tick to all agents
    do i = 1, N_PRODUCERS
      rc = orca_send_str(producers(i), '{"type":"tick"}')
    end do
    do i = 1, N_CONSUMERS
      rc = orca_send_str(consumers(i), '{"type":"tick"}')
    end do
    do i = 1, N_SPECULATORS
      rc = orca_send_str(speculators(i), '{"type":"tick"}')
    end do

    ! 2b. Wait for all (no-op for sync executor, but maintains the pattern)
    do i = 1, N_PRODUCERS
      rc = orca_wait_c(producers(i))
    end do
    do i = 1, N_CONSUMERS
      rc = orca_wait_c(consumers(i))
    end do
    do i = 1, N_SPECULATORS
      rc = orca_wait_c(speculators(i))
    end do

    ! 2c. Compute market price from producer prices
    call compute_market_price(producers, N_PRODUCERS, market_price)

    ! Update shared price for action callbacks BEFORE sending price_signal
    current_market_price = market_price

    ! 2d. Send price signal to all agents
    write(price_str, '(F8.2)') market_price
    price_event = '{"type":"price_signal","payload":{"price":' // &
                  trim(adjustl(price_str)) // '}}'

    do i = 1, N_PRODUCERS
      rc = orca_send_str(producers(i), trim(price_event))
    end do
    do i = 1, N_CONSUMERS
      rc = orca_send_str(consumers(i), trim(price_event))
    end do
    do i = 1, N_SPECULATORS
      rc = orca_send_str(speculators(i), trim(price_event))
    end do

    ! 2e. Wait for price signal round
    do i = 1, N_PRODUCERS
      rc = orca_wait_c(producers(i))
    end do
    do i = 1, N_CONSUMERS
      rc = orca_wait_c(consumers(i))
    end do
    do i = 1, N_SPECULATORS
      rc = orca_wait_c(speculators(i))
    end do

    ! Progress report every 10 ticks
    if (mod(tick, 10) == 0) then
      ! Gather consumer stats for this tick
      total_goods = 0.0d0
      total_cash = 0.0d0
      do i = 1, N_CONSUMERS
        call orca_get_state(consumers(i), state_buf, 2048, actual_len, rc)
        total_goods = total_goods + json_get_number(state_buf, 'goods')
        total_cash  = total_cash  + json_get_number(state_buf, 'cash')
      end do
      write(*,'(A,I4,A,F8.2,A,F8.1,A,F8.1)') &
           '  Tick ', tick, '  price=', market_price, &
           '  consumer_goods=', total_goods, '  consumer_cash=', total_cash
    end if
  end do

  ! ============================================================
  ! 3. Final wealth report
  ! ============================================================
  write(*,*)
  write(*,'(A)') '================================================================'
  write(*,'(A)') '  FINAL WEALTH REPORT'
  write(*,'(A)') '================================================================'

  ! Producer totals
  total_inventory = 0.0d0
  do i = 1, N_PRODUCERS
    call orca_get_state(producers(i), state_buf, 2048, actual_len, rc)
    total_inventory = total_inventory + json_get_number(state_buf, 'inventory')
  end do
  write(*,'(A,I0,A,F12.1)') '  Producers  (', N_PRODUCERS, &
       '): total inventory = ', total_inventory

  ! Consumer totals
  total_cash = 0.0d0
  total_goods = 0.0d0
  do i = 1, N_CONSUMERS
    call orca_get_state(consumers(i), state_buf, 2048, actual_len, rc)
    total_cash  = total_cash  + json_get_number(state_buf, 'cash')
    total_goods = total_goods + json_get_number(state_buf, 'goods')
  end do
  write(*,'(A,I0,A,F12.1,A,F8.1)') '  Consumers  (', N_CONSUMERS, &
       '): total cash = ', total_cash, '  total goods = ', total_goods

  ! Speculator totals
  total_spec_cash = 0.0d0
  do i = 1, N_SPECULATORS
    call orca_get_state(speculators(i), state_buf, 2048, actual_len, rc)
    total_spec_cash = total_spec_cash + json_get_number(state_buf, 'cash')
  end do
  write(*,'(A,I0,A,F12.1)') '  Speculators(', N_SPECULATORS, &
       '): total cash = ', total_spec_cash

  write(*,*)
  write(*,'(A,F8.2)') '  Final market price: ', market_price
  write(*,'(A)') '================================================================'
  write(*,'(A)') '  demo-fortran: PASS'
  write(*,'(A)') '================================================================'

  ! ============================================================
  ! 4. Cleanup
  ! ============================================================
  do i = 1, N_PRODUCERS
    call orca_free_c(producers(i))
  end do
  do i = 1, N_CONSUMERS
    call orca_free_c(consumers(i))
  end do
  do i = 1, N_SPECULATORS
    call orca_free_c(speculators(i))
  end do

  if (allocated(producer_md))   deallocate(producer_md)
  if (allocated(consumer_md))   deallocate(consumer_md)
  if (allocated(speculator_md)) deallocate(speculator_md)

contains

  ! Compute average price across all producers
  subroutine compute_market_price(handles, n, price)
    type(c_ptr), intent(in) :: handles(:)
    integer, intent(in) :: n
    real(c_double), intent(out) :: price
    character(len=2048) :: buf
    integer(c_size_t) :: alen
    integer(c_int) :: irc
    real(c_double) :: total
    integer :: j

    total = 0.0d0
    do j = 1, n
      call orca_get_state(handles(j), buf, 2048, alen, irc)
      total = total + json_get_number(buf, 'price')
    end do
    price = total / dble(n)
  end subroutine

  ! Read an entire file into an allocatable string
  subroutine load_file(filename, content)
    character(len=*), intent(in) :: filename
    character(len=:), allocatable, intent(out) :: content
    integer :: unit_num, file_size, io_stat
    logical :: exists

    inquire(file=filename, exist=exists, size=file_size)
    if (.not. exists) then
      write(*,'(A,A)') 'ERROR: File not found: ', filename
      stop 1
    end if

    allocate(character(len=file_size) :: content)
    open(newunit=unit_num, file=filename, status='old', &
         access='stream', form='unformatted', iostat=io_stat)
    if (io_stat /= 0) then
      write(*,'(A,A)') 'ERROR: Cannot open file: ', filename
      stop 1
    end if
    read(unit_num) content
    close(unit_num)
  end subroutine

end program market_simulation
