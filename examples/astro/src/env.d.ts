declare namespace App {
	interface Locals {
		/** The signed-in site member (not an EmDash staff user). */
		member?: import("emdash-memberships").Member;
	}
}
