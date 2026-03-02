from pymodbus.client.sync import ModbusTcpClient
import time


def create_client(ip, port=502, timeout=1.0):
    """
    Create a persistent Modbus TCP client.
    timeout: TCP read timeout in seconds; configurable from dashboard settings.
    """
    client = ModbusTcpClient(host=ip, port=port, timeout=timeout, retry_on_empty=False)
    try:
        client.connect()
    except Exception:
        pass
    return client


def read_input(client, address, count, unit):
    try:
        r = client.read_input_registers(address=address, count=count, unit=unit)
        if r and not r.isError():
            return r.registers
    except Exception:
        pass
    return None


def read_holding(client, address, count, unit):
    try:
        r = client.read_holding_registers(address=address, count=count, unit=unit)
        if r and not r.isError():
            return r.registers
    except Exception:
        pass
    return None


def write_single(client, address, value, unit):
    """
    Safe FC6 single register write. Returns True on success.
    """
    try:
        r = client.write_register(address, value, unit=unit)
        if r and not r.isError():
            return True
    except Exception:
        pass

    # reconnect and retry
    try:
        client.close()
    except Exception:
        pass

    time.sleep(0.1)

    try:
        client.connect()
    except Exception:
        pass

    time.sleep(0.1)

    try:
        r = client.write_register(address, value, unit=unit)
        if r and not r.isError():
            return True
    except Exception:
        pass

    return False
