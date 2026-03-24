import { useMemo, useState, type ComponentType } from 'react';
import type { SvgIconProps } from '@mui/material';
import { Box, IconButton, InputAdornment, Link, TextField, Tooltip, Typography } from '@mui/material';

const MUI_ICONS_DOC_URL = 'https://mui.com/material-ui/material-icons/?query=food';
import * as MuiIcons from '@mui/icons-material';

const MUI_PREFIX = 'mui:';

type IconComp = ComponentType<SvgIconProps>;

function isIconExport(v: unknown): v is IconComp {
  if (v == null) return false;
  if (typeof v === 'function') return true;
  if (typeof v === 'object' && '$$typeof' in v) return true;
  return false;
}

function buildMuiIconRegistry(): {
  allNames: readonly string[];
  byName: ReadonlyMap<string, IconComp>;
} {
  const raw = MuiIcons as Record<string, unknown>;
  const names: string[] = [];
  const byName = new Map<string, IconComp>();
  for (const key of Object.keys(raw)) {
    if (key === 'default') continue;
    const v = raw[key];
    if (!isIconExport(v)) continue;
    names.push(key);
    byName.set(key, v);
  }
  names.sort((a, b) => a.localeCompare(b));
  return { allNames: names, byName };
}

const MUI_REGISTRY = buildMuiIconRegistry();

const FallbackIcon = MUI_REGISTRY.byName.get('Category')!;
const BlockIcon = MUI_REGISTRY.byName.get('Block') ?? FallbackIcon;
const SearchGlyph = MUI_REGISTRY.byName.get('Search');

const VISIBLE_CAP = 200;

export function muiIconToken(name: string): string {
  return `${MUI_PREFIX}${name}`;
}

export function CategorySymbolDisplay({
  value,
  fontSize = '1.5rem',
}: {
  value: string | null | undefined;
  fontSize?: string | number;
}) {
  if (!value) return null;
  if (value.startsWith(MUI_PREFIX)) {
    const name = value.slice(MUI_PREFIX.length);
    const Icon = MUI_REGISTRY.byName.get(name) ?? FallbackIcon;
    return (
      <Icon
        sx={{
          fontSize,
          color: 'text.primary',
          verticalAlign: 'middle',
          display: 'inline-block',
        }}
        aria-hidden
      />
    );
  }
  return (
    <Typography component="span" sx={{ fontSize, lineHeight: 1, verticalAlign: 'middle' }}>
      {value}
    </Typography>
  );
}

export function CategorySymbolPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const [query, setQuery] = useState('');
  const selectedMui = value.startsWith(MUI_PREFIX) ? value.slice(MUI_PREFIX.length) : '';

  const { visibleNames, totalHits } = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return {
        visibleNames: MUI_REGISTRY.allNames.slice(0, VISIBLE_CAP),
        totalHits: MUI_REGISTRY.allNames.length,
      };
    }
    const hits = MUI_REGISTRY.allNames.filter((n) => n.toLowerCase().includes(q));
    return {
      visibleNames: hits.slice(0, VISIBLE_CAP),
      totalHits: hits.length,
    };
  }, [query]);

  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
        Symbol (optional) — alle Material Icons, einfarbig (Textfarbe)
      </Typography>
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
        <Link href={MUI_ICONS_DOC_URL} target="_blank" rel="noopener noreferrer">
          mui.com: Material Icons
        </Link>{' '}
        — Übersicht und Suche mit Synonymen; hier den englischen Komponentennamen übernehmen.
      </Typography>
      <TextField
        size="small"
        fullWidth
        placeholder="Suche nach englischem Icon-Namen …"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        sx={{ mb: 1 }}
        InputProps={{
          startAdornment: SearchGlyph ? (
            <InputAdornment position="start">
              <SearchGlyph fontSize="small" color="action" />
            </InputAdornment>
          ) : undefined,
        }}
      />
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.75 }}>
        {query.trim()
          ? `${totalHits} Treffer${totalHits > VISIBLE_CAP ? `, zeige ${VISIBLE_CAP}` : ''}`
          : `${MUI_REGISTRY.allNames.length} Icons — Suchbegriff eingeben oder erste ${VISIBLE_CAP} anzeigen`}
      </Typography>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(44px, 1fr))',
          gap: 0.5,
          maxHeight: 280,
          overflowY: 'auto',
          pr: 0.5,
        }}
      >
        <Tooltip title="Keins">
          <IconButton
            size="small"
            onClick={() => onChange('')}
            color={value === '' ? 'primary' : 'default'}
            sx={{
              border: 1,
              borderColor: value === '' ? 'primary.main' : 'divider',
              borderRadius: 1,
            }}
            aria-label="Kein Symbol"
          >
            <BlockIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        {visibleNames.map((name) => {
          const Icon = MUI_REGISTRY.byName.get(name)!;
          const sel = selectedMui === name;
          return (
            <Tooltip key={name} title={name}>
              <IconButton
                size="small"
                onClick={() => onChange(muiIconToken(name))}
                color={sel ? 'primary' : 'default'}
                sx={{
                  border: 1,
                  borderColor: sel ? 'primary.main' : 'divider',
                  borderRadius: 1,
                }}
                aria-label={name}
              >
                <Icon fontSize="small" />
              </IconButton>
            </Tooltip>
          );
        })}
      </Box>
    </Box>
  );
}
