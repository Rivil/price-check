-- Hand-added comment. Destructive: the better-auth tables go with every account,
-- session and password in them. Data belongs to the install now (decision data_scope);
-- 0009 and 0010 already removed every user_id that pointed here.
DROP TABLE `account`;--> statement-breakpoint
DROP TABLE `session`;--> statement-breakpoint
DROP TABLE `user`;--> statement-breakpoint
DROP TABLE `verification`;
