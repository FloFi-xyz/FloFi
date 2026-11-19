// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The approved FloFi symbol and wordmark follow the console palette before hydration.
 */
export function AdminBrand() {
  return <div className="admin-brand">
    <span className="admin-brand-symbol" aria-hidden="true">
      <img data-artwork="light" src="/brand/flofi-symbol-light.svg" alt="" width={370} height={345}/>
      <img data-artwork="dark" src="/brand/flofi-symbol-dark.svg" alt="" width={370} height={345}/>
    </span>
    <div>
      <span className="admin-brand-name">
        <span>
          <img data-artwork="light" src="/brand/flofi-wordmark-light.png" alt="FloFi" width={738} height={280}/>
          <img data-artwork="dark" src="/brand/flofi-wordmark-dark.png" alt="FloFi" width={738} height={280}/>
        </span>
        <span>Admin</span>
      </span>
      <small>Private console</small>
    </div>
  </div>;
}
