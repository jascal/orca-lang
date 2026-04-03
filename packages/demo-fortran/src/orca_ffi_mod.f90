module orca_ffi
  use, intrinsic :: iso_c_binding
  implicit none

  ! Error codes (must match run_orca_ffi.h)
  integer(c_int), parameter :: ORCA_OK         =  0
  integer(c_int), parameter :: ORCA_ERR_PARSE  = -1
  integer(c_int), parameter :: ORCA_ERR_VERIFY = -2
  integer(c_int), parameter :: ORCA_ERR_RUNTIME= -3
  integer(c_int), parameter :: ORCA_ERR_INVALID= -4

  ! C function interfaces
  interface

    ! orca_init: parse + verify + start a machine
    integer(c_int) function orca_init_c(source, source_len, handle_ptr) &
        bind(C, name='orca_init')
      import :: c_char, c_int, c_size_t, c_ptr
      character(kind=c_char), intent(in) :: source(*)
      integer(c_size_t), value :: source_len
      type(c_ptr), intent(out) :: handle_ptr
    end function

    ! orca_free: release a machine handle
    subroutine orca_free_c(handle) bind(C, name='orca_free')
      import :: c_ptr
      type(c_ptr), value :: handle
    end subroutine

    ! orca_send: dispatch an event (synchronous)
    integer(c_int) function orca_send_c(handle, event_json, event_len) &
        bind(C, name='orca_send')
      import :: c_char, c_int, c_size_t, c_ptr
      type(c_ptr), value :: handle
      character(kind=c_char), intent(in) :: event_json(*)
      integer(c_size_t), value :: event_len
    end function

    ! orca_wait: block until idle (no-op for sync executor)
    integer(c_int) function orca_wait_c(handle) bind(C, name='orca_wait')
      import :: c_int, c_ptr
      type(c_ptr), value :: handle
    end function

    ! orca_state: get state+context as JSON
    integer(c_int) function orca_state_c(handle, buf, buf_len, actual_len) &
        bind(C, name='orca_state')
      import :: c_char, c_int, c_size_t, c_ptr
      type(c_ptr), value :: handle
      character(kind=c_char), intent(out) :: buf(*)
      integer(c_size_t), value :: buf_len
      type(c_ptr), value :: actual_len
    end function

    ! orca_register_action: register a C function pointer as action handler
    integer(c_int) function orca_register_action_c(handle, name, callback) &
        bind(C, name='orca_register_action')
      import :: c_char, c_int, c_ptr, c_funptr
      type(c_ptr), value :: handle
      character(kind=c_char), intent(in) :: name(*)
      type(c_funptr), value :: callback
    end function

  end interface

contains

  ! -- Convenience wrappers for Fortran callers --

  ! Initialize a machine from a Fortran string
  function orca_init_str(machine_md, handle) result(rc)
    character(len=*), intent(in) :: machine_md
    type(c_ptr), intent(out) :: handle
    integer(c_int) :: rc
    rc = orca_init_c(machine_md, int(len_trim(machine_md), c_size_t), handle)
  end function

  ! Send an event from a Fortran string
  function orca_send_str(handle, event_json) result(rc)
    type(c_ptr), intent(in) :: handle
    character(len=*), intent(in) :: event_json
    integer(c_int) :: rc
    rc = orca_send_c(handle, event_json, int(len_trim(event_json), c_size_t))
  end function

  ! Get state JSON into a Fortran character buffer
  subroutine orca_get_state(handle, buf, buf_len, actual_len, rc)
    type(c_ptr), intent(in) :: handle
    character(len=*), intent(out) :: buf
    integer, intent(in) :: buf_len
    integer(c_size_t), intent(out) :: actual_len
    integer(c_int), intent(out) :: rc
    integer(c_size_t), target :: alen
    alen = 0
    rc = orca_state_c(handle, buf, int(buf_len, c_size_t), c_loc(alen))
    actual_len = alen
  end subroutine

  ! Register an action (Fortran string name + C function pointer)
  function orca_register_action_str(handle, name, callback) result(rc)
    type(c_ptr), intent(in) :: handle
    character(len=*), intent(in) :: name
    type(c_funptr), intent(in) :: callback
    integer(c_int) :: rc
    ! Null-terminate the name for C
    rc = orca_register_action_c(handle, name // c_null_char, callback)
  end function

end module orca_ffi
