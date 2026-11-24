-- Mandi Plus 2: the counter app under com.mandiplus.pos, signed with its own key because the old
-- app's release key is not at hand. Its builds can never install over the old app (nor the old
-- over it), so it gets its own release channel beside 'pos'.
ALTER TABLE app_releases DROP CONSTRAINT app_releases_flavor_check;
ALTER TABLE app_releases ADD CONSTRAINT app_releases_flavor_check CHECK (flavor IN ('pos', 'daybook', 'tally', 'admin', 'desktop', 'desktop-new', 'pos2'));

-- Whoever may publish the counter app may publish Mandi Plus 2: new tokens get it by default, and
-- live tokens that can publish 'pos' gain it.
ALTER TABLE release_publishers ALTER COLUMN flavors SET DEFAULT '{pos,daybook,pos2}';
UPDATE release_publishers SET flavors = array_append(flavors, 'pos2')
WHERE revoked_at IS NULL AND 'pos' = ANY (flavors) AND NOT 'pos2' = ANY (flavors);
