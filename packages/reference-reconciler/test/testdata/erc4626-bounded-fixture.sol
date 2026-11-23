// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.30;

// Disposable contracts for checking the bounded-deposit ABI and real receipt
// semantics on Anvil. This fixture implements the exercised ERC-4626 surface.
contract TestAsset {
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Transfer(address indexed from, address indexed to, uint256 value);

    constructor() { balanceOf[msg.sender] = 10_000_000; }

    function approve(address spender, uint256 assets) external returns (bool) {
        allowance[msg.sender][spender] = assets;
        emit Approval(msg.sender, spender, assets);
        return true;
    }

    function transferFrom(address owner, address receiver, uint256 assets) external returns (bool) {
        allowance[owner][msg.sender] -= assets;
        balanceOf[owner] -= assets;
        balanceOf[receiver] += assets;
        emit Transfer(owner, receiver, assets);
        return true;
    }
}

contract TestVault {
    uint8 public constant decimals = 6;
    TestAsset public immutable asset;
    mapping(address => uint256) public balanceOf;
    uint256 private _offerPerAsset = 2;
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares);

    constructor(TestAsset underlying) { asset = underlying; }

    // Fixture control for price movement between review and execution.
    function setOffer(uint256 sharesPerAsset) external { _offerPerAsset = sharesPerAsset; }

    function totalAssets() external view returns (uint256) { return asset.balanceOf(address(this)); }
    function maxDeposit(address) external pure returns (uint256) { return 10_000_000; }
    function previewDeposit(uint256 assets) public view returns (uint256) { return assets * _offerPerAsset; }

    function deposit(uint256 assets, address receiver) external returns (uint256) {
        return deposit(assets, receiver, 0);
    }

    function deposit(uint256 assets, address receiver, uint256 minimumShares) public returns (uint256 shares) {
        shares = previewDeposit(assets);
        require(shares >= minimumShares, "min shares");
        require(asset.transferFrom(msg.sender, address(this), assets), "asset transfer");
        balanceOf[receiver] += shares;
        emit Transfer(address(0), receiver, shares);
        emit Deposit(msg.sender, receiver, assets, shares);
    }
}
