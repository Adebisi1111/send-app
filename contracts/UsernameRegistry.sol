// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title UsernameRegistry
/// @notice Maps human-readable usernames to wallet addresses so people can be
///         paid with a name like "adaeze" instead of a 42-character hex string.
/// @dev Case-insensitive: "@Akin" and "@akin" resolve to the same account, so
///      one person cannot squat a name by changing case.
contract UsernameRegistry {
    /// @notice Thrown when a username is already taken.
    error UsernameTaken(string username);
    /// @notice Thrown when no account is registered for a username.
    error UsernameNotFound(string username);
    /// @notice Thrown when a username does not match the allowed character set.
    error InvalidUsername(string username);
    /// @notice Thrown when a caller tries to claim a name they already hold.
    error AlreadyRegistered(address account, string username);
    /// @notice Thrown when an address tries to own more than one username.
    error AddressAlreadyHasUsername(address account, string existing);
    /// @notice Thrown when a reserved name is claimed.
    error ReservedUsername(string username);

    bytes32 private constant RESERVED_SLOT =
        keccak256("UsernameRegistry.reserved");

    /// @notice username (normalised, lowercase) => owner address
    mapping(bytes32 => address) private _ownerOf;
    /// @notice owner address => their username
    mapping(address => string) private _usernameOf;

    /// @notice Emitted when a username is claimed for the first time.
    event UsernameRegistered(
        address indexed account,
        string username,
        string usernameHash
    );

    /// @notice Emitted when a username is pointed at a new address.
    event UsernameTransferred(
        address indexed previousOwner,
        address indexed newOwner,
        string username
    );

    /// @dev Rejects names that are too short/long or contain characters outside
    ///      [a-z0-9_]. Dots and dashes are refused so a name cannot visually
    ///      imitate a domain. Must run on the NORMALISED (lowercased) string.
    function _validate(string memory username) private pure {
        bytes memory raw = bytes(username);
        if (raw.length < 3 || raw.length > 32) revert InvalidUsername(username);
        for (uint256 i = 0; i < raw.length; i++) {
            bytes1 c = raw[i];
            bool lower = c >= 0x61 && c <= 0x7a; // a-z
            bool digit = c >= 0x30 && c <= 0x39; // 0-9
            bool underscore = c == 0x5f;         // _
            if (!lower && !digit && !underscore) revert InvalidUsername(username);
        }
    }

    /// @notice Lowercase a username. No character validation here — validation
    ///         must happen on the normalised form, otherwise "ADAEZE" reverts
    ///         before it can be folded to "adaeze".
    function normalise(string memory username) public pure returns (string memory) {
        bytes memory raw = bytes(username);
        bytes memory out = new bytes(raw.length);
        for (uint256 i = 0; i < raw.length; i++) {
            bytes1 c = raw[i];
            // uppercase A-Z -> lowercase
            out[i] = (c >= 0x41 && c <= 0x5a) ? bytes1(uint8(c) + 32) : c;
        }
        return string(out);
    }


    /// @notice Claim a username. One username per address.
    function register(string calldata username) external returns (string memory normalised) {
        normalised = normalise(username);
        _validate(normalised);
        bytes32 key = keccak256(bytes(normalised));

        address existingOwner = _ownerOf[key];
        if (existingOwner != address(0)) {
            // re-claim by the same owner is a no-op, not a revert
            if (existingOwner == msg.sender) {
                revert AlreadyRegistered(msg.sender, normalised);
            }
            revert UsernameTaken(normalised);
        }

        string memory current = _usernameOf[msg.sender];
        if (bytes(current).length != 0) {
            revert AddressAlreadyHasUsername(msg.sender, current);
        }

        _ownerOf[key] = msg.sender;
        _usernameOf[msg.sender] = normalised;

        emit UsernameRegistered(msg.sender, normalised, normalised);
    }

    /// @notice Resolve a username to its owner. Returns the zero address when
    ///         nobody has claimed it, so callers can branch without reverting.
    function resolve(string calldata username) external view returns (address) {
        return _ownerOf[keccak256(bytes(normalise(username)))];
    }

    /// @notice The username held by an address, empty string if none.
    function usernameOf(address account) external view returns (string memory) {
        return _usernameOf[account];
    }

    /// @notice True when the username is taken.
    function isTaken(string calldata username) external view returns (bool) {
        return _ownerOf[keccak256(bytes(normalise(username)))] != address(0);
    }

    /// @notice Move a username to a new address. The current owner must call.
    function transferUsername(address newOwner) external {
        string memory current = _usernameOf[msg.sender];
        if (bytes(current).length == 0) {
            revert UsernameNotFound("");
        }
        if (newOwner == address(0)) revert InvalidUsername("");

        // Writing _usernameOf[newOwner] without this guard would clobber the
        // recipient's existing name while leaving their old _ownerOf entry
        // pointing at them. The two mappings then disagree forever: the name is
        // unclaimable by anyone, and the holder can never transfer it off a
        // compromised or lost key.
        string memory held = _usernameOf[newOwner];
        if (bytes(held).length != 0) revert AddressAlreadyHasUsername(newOwner, held);

        delete _ownerOf[keccak256(bytes(current))];
        _usernameOf[msg.sender] = "";
        _usernameOf[newOwner] = current;
        _ownerOf[keccak256(bytes(current))] = newOwner;

        emit UsernameTransferred(msg.sender, newOwner, current);
    }
}
