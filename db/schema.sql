-- P1-SSE — Azure SQL schema
-- Replaces the single Supabase app_rates.config JSON blob with normalized,
-- versioned rate tables, plus new server-side persistence for quotes/contracts
-- (previously only stored in the browser's localStorage).

-- ===========================================================================
-- 1. RATE CONFIGURATION (replaces app_rates.config)
-- ===========================================================================

CREATE TABLE dbo.Product (
  ProductId     INT IDENTITY PRIMARY KEY,
  Tag           NVARCHAR(20) NOT NULL UNIQUE  -- was app_rates.app, e.g. 'sse'
);

-- One row per published rate set. Only one profile per product may be active
-- at a time. Old profiles are kept for quote-history auditing.
CREATE TABLE dbo.RateProfile (
  RateProfileId INT IDENTITY PRIMARY KEY,
  ProductId     INT NOT NULL REFERENCES dbo.Product(ProductId),
  Version       INT NOT NULL,
  IsActive      BIT NOT NULL DEFAULT 0,
  EffectiveFrom DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  CreatedBy     NVARCHAR(200) NULL,          -- Entra user principal name
  CreatedAt     DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  CONSTRAINT UQ_RateProfile_ProductVersion UNIQUE (ProductId, Version)
);

-- Enforce "only one active profile per product" via a filtered unique index.
CREATE UNIQUE INDEX UX_RateProfile_OneActivePerProduct
  ON dbo.RateProfile (ProductId)
  WHERE IsActive = 1;

-- Scalar labor/margin defaults. One row per profile.
-- (was P1_RATES.laborBillDefault, laborCostPerHr, laborSellDefault, svcGM,
--  subMarkup, avMaintGM, matMarkup, tmSubGM, overheadRate)
CREATE TABLE dbo.LaborRate (
  RateProfileId     INT NOT NULL PRIMARY KEY REFERENCES dbo.RateProfile(RateProfileId),
  LaborCostPerHr    DECIMAL(10,2) NOT NULL,
  LaborBillDefault  DECIMAL(10,2) NOT NULL,
  LaborSellDefault  DECIMAL(10,2) NOT NULL,
  SvcGM             DECIMAL(5,2)  NOT NULL,  -- percent, e.g. 45.00
  SubMarkup         DECIMAL(5,2)  NOT NULL,
  AvMaintGM         DECIMAL(5,2)  NOT NULL,
  MatMarkup         DECIMAL(5,2)  NOT NULL,
  TmSubGM           DECIMAL(5,2)  NOT NULL,
  OverheadRate      DECIMAL(5,2)  NOT NULL
);

-- Service-call multipliers (was P1_RATES.svcStraight/svcTimeAndHalf/
-- svcDoubleTime, priorityMultiplier, premierMultiplier)
CREATE TABLE dbo.ServiceCallRate (
  RateProfileId       INT NOT NULL PRIMARY KEY REFERENCES dbo.RateProfile(RateProfileId),
  StraightTimeRate    DECIMAL(10,2) NOT NULL,
  TimeAndHalfRate     DECIMAL(10,2) NOT NULL,
  DoubleTimeRate      DECIMAL(10,2) NOT NULL,
  PriorityMultiplier  DECIMAL(5,2)  NOT NULL,
  PremierMultiplier   DECIMAL(5,2)  NOT NULL
);

-- Monitoring RMR base/addon (was P1_RATES.monBase, monAddon)
CREATE TABLE dbo.MonitoringRate (
  RateProfileId INT NOT NULL PRIMARY KEY REFERENCES dbo.RateProfile(RateProfileId),
  BaseRate      DECIMAL(10,2) NOT NULL,
  AddonRate     DECIMAL(10,2) NOT NULL
);

-- Access-control door pricing (was P1_RATES.doorRateSACP/doorRateStd)
CREATE TABLE dbo.DoorRate (
  RateProfileId INT NOT NULL PRIMARY KEY REFERENCES dbo.RateProfile(RateProfileId),
  SacpRate      DECIMAL(10,2) NOT NULL,
  StandardRate  DECIMAL(10,2) NOT NULL
);

-- Door bundle break points (was P1_RATES.doorBundlesSACP / doorBundlesStd arrays)
CREATE TABLE dbo.DoorBundle (
  DoorBundleId  INT IDENTITY PRIMARY KEY,
  RateProfileId INT NOT NULL REFERENCES dbo.RateProfile(RateProfileId),
  BundleType    NVARCHAR(10) NOT NULL CHECK (BundleType IN ('SACP','Standard')),
  MinDoors      INT NOT NULL,
  MaxDoors      INT NULL,             -- NULL = unbounded top tier
  Price         DECIMAL(10,2) NOT NULL,
  SortOrder     INT NOT NULL
);
CREATE INDEX IX_DoorBundle_Profile ON dbo.DoorBundle(RateProfileId, BundleType, SortOrder);

-- Video monitoring pricing (was P1_RATES.videoExpansionBase, videoSvr)
CREATE TABLE dbo.VideoRate (
  RateProfileId     INT NOT NULL PRIMARY KEY REFERENCES dbo.RateProfile(RateProfileId),
  ExpansionBaseRate DECIMAL(10,2) NOT NULL,
  ServerRate        DECIMAL(10,2) NOT NULL
);

-- Central station / GCS pricing by system type
-- (was P1_RATES.gcsFire, gcsBurg, gcsResidential, gcsTwoWay,
--  sfBurgResidential, sfBurgCommercial)
CREATE TABLE dbo.GcsRate (
  RateProfileId     INT NOT NULL PRIMARY KEY REFERENCES dbo.RateProfile(RateProfileId),
  FireRate          DECIMAL(10,2) NOT NULL,
  BurgRate          DECIMAL(10,2) NOT NULL,
  ResidentialRate   DECIMAL(10,2) NOT NULL,
  TwoWayRate        DECIMAL(10,2) NOT NULL,
  SfBurgResidential DECIMAL(10,2) NOT NULL,
  SfBurgCommercial  DECIMAL(10,2) NOT NULL
);

-- Minimum RMR floors by system/site type
-- (was P1_RATES.minRMRCommercial, minRMRResidential, minRMRTwoWay)
CREATE TABLE dbo.MinRmrRate (
  RateProfileId     INT NOT NULL PRIMARY KEY REFERENCES dbo.RateProfile(RateProfileId),
  CommercialFloor   DECIMAL(10,2) NOT NULL,
  ResidentialFloor  DECIMAL(10,2) NOT NULL,
  TwoWayFloor       DECIMAL(10,2) NOT NULL
);

-- Flat named rates that don't fit a bigger group
-- (was P1_RATES.ulCerts, pmVisitRate)
CREATE TABLE dbo.MiscRate (
  RateProfileId INT NOT NULL REFERENCES dbo.RateProfile(RateProfileId),
  RateKey       NVARCHAR(50) NOT NULL,   -- 'ulCerts', 'pmVisitRate', ...
  RateValue     DECIMAL(10,2) NOT NULL,
  PRIMARY KEY (RateProfileId, RateKey)
);

-- SLA service tiers (was P1_RATES.tierRates + tierRatesLabel)
CREATE TABLE dbo.TierRate (
  TierRateId    INT IDENTITY PRIMARY KEY,
  RateProfileId INT NOT NULL REFERENCES dbo.RateProfile(RateProfileId),
  TierName      NVARCHAR(50) NOT NULL,   -- e.g. 'Standard', 'Priority', 'Premier'
  Label         NVARCHAR(100) NULL,
  Rate          DECIMAL(10,2) NOT NULL,
  SortOrder     INT NOT NULL
);
CREATE INDEX IX_TierRate_Profile ON dbo.TierRate(RateProfileId, SortOrder);

-- Pricing dropdown menus (replaces P1_RATES.dropdownsHTML raw markup).
-- DropdownGroup corresponds to the old element id, e.g. 'adc-video',
-- 'adc-base', 'connectone', 'alarmnet'. The React <select> renders these
-- as real <option> elements instead of injecting stored HTML.
CREATE TABLE dbo.PricingOption (
  PricingOptionId INT IDENTITY PRIMARY KEY,
  RateProfileId   INT NOT NULL REFERENCES dbo.RateProfile(RateProfileId),
  DropdownGroup   NVARCHAR(50) NOT NULL,
  OptionValue     NVARCHAR(50) NOT NULL,   -- the <option value="...">
  Label           NVARCHAR(200) NOT NULL,  -- the visible <option> text
  Price           DECIMAL(10,2) NULL,
  SortOrder       INT NOT NULL
);
CREATE INDEX IX_PricingOption_Profile ON dbo.PricingOption(RateProfileId, DropdownGroup, SortOrder);

-- ===========================================================================
-- 2. BUSINESS DATA (new — previously localStorage-only)
-- ===========================================================================

CREATE TABLE dbo.Customer (
  CustomerId    INT IDENTITY PRIMARY KEY,
  Name          NVARCHAR(200) NOT NULL,
  ContactName   NVARCHAR(200) NULL,
  Phone         NVARCHAR(30)  NULL,
  Email         NVARCHAR(200) NULL,
  BillingAddress NVARCHAR(300) NULL,
  OwnerObjectId NVARCHAR(100) NOT NULL,   -- Entra oid of the creating user
  CreatedAt     DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);

-- Shared between Quote Builder and Monitoring Contracts, per the note in the
-- legacy UI: "Sites are shared with the Monitoring Contracts tab."
CREATE TABLE dbo.Site (
  SiteId        INT IDENTITY PRIMARY KEY,
  CustomerId    INT NOT NULL REFERENCES dbo.Customer(CustomerId),
  Label         NVARCHAR(100) NULL,        -- 'Site 1', 'Site 2', ...
  Address       NVARCHAR(300) NOT NULL,
  City          NVARCHAR(100) NULL,
  State         NVARCHAR(2)   NULL,
  Zip           NVARCHAR(10)  NULL,
  MonthlyRate   DECIMAL(10,2) NULL,
  SortOrder     INT NOT NULL DEFAULT 0
);
CREATE INDEX IX_Site_Customer ON dbo.Site(CustomerId, SortOrder);

CREATE TABLE dbo.Quote (
  QuoteId       INT IDENTITY PRIMARY KEY,
  CustomerId    INT NOT NULL REFERENCES dbo.Customer(CustomerId),
  RateProfileId INT NOT NULL REFERENCES dbo.RateProfile(RateProfileId),  -- pin the rates used
  EstimateType  NVARCHAR(30) NOT NULL,     -- 'time_and_materials' | 'flat_rate'
  SystemType    NVARCHAR(50) NULL,
  SiteType      NVARCHAR(30) NULL,         -- 'Residential' | 'Commercial'
  FormData      NVARCHAR(MAX) NOT NULL,    -- structured line items, CHECK below enforces valid JSON
  RecommendedRmr DECIMAL(10,2) NULL,
  MonitoringRmr  DECIMAL(10,2) NULL,
  OwnerObjectId NVARCHAR(100) NOT NULL,
  CreatedAt     DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  UpdatedAt     DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  CONSTRAINT CK_Quote_FormData_JSON CHECK (ISJSON(FormData) = 1)
);
CREATE INDEX IX_Quote_Customer ON dbo.Quote(CustomerId);
CREATE INDEX IX_Quote_Owner ON dbo.Quote(OwnerObjectId);

CREATE TABLE dbo.Contract (
  ContractId    INT IDENTITY PRIMARY KEY,
  CustomerId    INT NOT NULL REFERENCES dbo.Customer(CustomerId),
  RateProfileId INT NOT NULL REFERENCES dbo.RateProfile(RateProfileId),
  ServiceTier   NVARCHAR(50) NULL,
  TermMonths    INT NULL,
  FormData      NVARCHAR(MAX) NOT NULL,    -- PM checklist, response times, exclusions, etc.
  SignedAt      DATETIME2 NULL,
  OwnerObjectId NVARCHAR(100) NOT NULL,
  CreatedAt     DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  UpdatedAt     DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  CONSTRAINT CK_Contract_FormData_JSON CHECK (ISJSON(FormData) = 1)
);
CREATE INDEX IX_Contract_Customer ON dbo.Contract(CustomerId);

CREATE TABLE dbo.Agreement (
  AgreementId   INT IDENTITY PRIMARY KEY,
  CustomerId    INT NOT NULL REFERENCES dbo.Customer(CustomerId),
  FormData      NVARCHAR(MAX) NOT NULL,
  OwnerObjectId NVARCHAR(100) NOT NULL,
  CreatedAt     DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  CONSTRAINT CK_Agreement_FormData_JSON CHECK (ISJSON(FormData) = 1)
);

-- Many-to-many: an Agreement can cover multiple Sites (mirrors the legacy
-- "sites" chip-selection UI on Monitoring Contracts agreements).
CREATE TABLE dbo.AgreementSite (
  AgreementId INT NOT NULL REFERENCES dbo.Agreement(AgreementId),
  SiteId      INT NOT NULL REFERENCES dbo.Site(SiteId),
  PRIMARY KEY (AgreementId, SiteId)
);

-- ===========================================================================
-- 3. CONVENIENCE VIEW for the /api/rates function
-- ===========================================================================

CREATE VIEW dbo.ActiveRateProfile AS
SELECT p.Tag AS ProductTag, rp.RateProfileId, rp.Version, rp.EffectiveFrom
FROM dbo.RateProfile rp
JOIN dbo.Product p ON p.ProductId = rp.ProductId
WHERE rp.IsActive = 1;
